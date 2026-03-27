import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import Database from "better-sqlite3";
import { Pool } from "pg";
import cors from "cors";
import dns from "dns";

// Force IPv4 first to avoid ENETUNREACH on IPv6-only hostnames in some environments
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder("ipv4first");
}

import axios from "axios";
import OpenAI from "openai";
import * as cheerio from "cheerio";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

// Use Stealth Plugin to avoid being detected as a bot by Weibo
let puppeteerStatus = "initializing";
try {
  puppeteer.use(StealthPlugin());
  puppeteerStatus = "ready";
} catch (e) {
  console.error("Failed to initialize Puppeteer Stealth Plugin:", e);
  puppeteerStatus = "failed: " + (e as Error).message;
}

// Handle unhandled rejections and exceptions to prevent server crashes
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception thrown:", err);
  // Optional: process.exit(1) if you want to force a restart
});

// Initialize OpenAI client for NVIDIA
const nvidia = new OpenAI({
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKey: process.env.NVIDIA_API_KEY || "",
});

// Initialize Database
const dbPath = process.env.DATABASE_PATH || "cbiz_content.db";
const databaseUrl = process.env.DATABASE_URL;

let db: any;
let isPostgres = false;

if (databaseUrl) {
  console.log("Using PostgreSQL (Supabase/Cloud)...");
  db = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false } // Required for Supabase/Render
  });
  isPostgres = true;
} else {
  if (process.env.RENDER) {
    console.warn("WARNING: Running on Render but DATABASE_URL is missing. SQLite will be used, but data will be lost on restart.");
  }
  console.log("Using SQLite (Local)...");
  db = new Database(dbPath);
}

if (!process.env.NVIDIA_API_KEY) {
  console.warn("WARNING: NVIDIA_API_KEY is missing. AI translation and rewriting will be disabled.");
}

const initDb = async (retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      if (isPostgres) {
        console.log(`Initializing PostgreSQL tables (Attempt ${i + 1}/${retries})...`);
        await db.query(`
          CREATE TABLE IF NOT EXISTS posts (
            id SERIAL PRIMARY KEY,
            original_title TEXT UNIQUE,
            rewritten_content TEXT,
            image_url TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            status TEXT DEFAULT 'pending'
          )
        `);
        console.log("PostgreSQL tables initialized.");
      } else {
        console.log("Initializing SQLite tables...");
        db.exec(`
          CREATE TABLE IF NOT EXISTS posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            original_title TEXT UNIQUE,
            rewritten_content TEXT,
            image_url TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            status TEXT DEFAULT 'pending'
          )
        `);
        console.log("SQLite tables initialized.");
      }
      return; // Success
    } catch (err: any) {
      console.error(`Database initialization failed (Attempt ${i + 1}/${retries}):`, err.message);
      if (i === retries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
    }
  }
};

// initDb().catch(err => console.error("Database init error:", err));

const app = express();
app.use(express.json());
app.use(cors());

const PORT = 3000;

// API Routes
app.get("/api/health", async (req, res) => {
  let dbStatus = "ok";
  try {
    if (isPostgres) {
      await db.query("SELECT 1");
    } else {
      db.prepare("SELECT 1").get();
    }
  } catch (e) {
    dbStatus = "failed: " + (e as Error).message;
  }

  res.json({ 
    status: "ok", 
    time: new Date().toISOString(),
    puppeteer: puppeteerStatus,
    database: dbStatus,
    mode: isPostgres ? "PostgreSQL" : "SQLite"
  });
});

app.get(["/api/crawl", "/api/crawl/"], async (req, res) => {
  const category = req.query.category as string || "entertainment";
  
  try {
    console.log(`Crawling Weibo Hot Search for category: ${category}...`);
    
    let topics: any[] = [];

    // 1. Primary Source: Weibo Direct APIs (Axios) - Fastest and most reliable for lists
    console.log("Trying Weibo Direct APIs (Axios) for Hot Search...");
    let containerId = "106003type%3D25%26t%3D3%26disable_hot%3D1%26filter_type%3Drealtime";
    if (category === "entertainment") {
      containerId = "106003type%3D25%26t%3D3%26disable_hot%3D1%26filter_type%3Dent";
    } else if (category === "social") {
      containerId = "106003type%3D25%26t%3D3%26disable_hot%3D1%26filter_type%3Dsocial";
    } else if (category === "life") {
      containerId = "106003type%3D25%26t%3D3%26disable_hot%3D1%26filter_type%3Dnews";
    }

    const primaryUrl = `https://m.weibo.cn/api/container/getIndex?containerid=${containerId}`;
    
    try {
      const response = await axios.get(primaryUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
          "Referer": "https://m.weibo.cn/",
          "X-Requested-With": "XMLHttpRequest"
        },
        timeout: 10000
      });
      
      if (response.data && response.data.data && response.data.data.cards) {
        for (const card of response.data.data.cards) {
          const group = card.card_group || card.group || (card.card_type === 11 ? [card] : []);
          if (Array.isArray(group)) {
            for (const item of group) {
              const title = item.desc || item.word || item.desc1 || item.title_sub;
              if (title && !String(title).includes("置顶")) {
                topics.push({
                  title: String(title).replace(/<[^>]*>/g, "").trim(),
                  query: String(title).trim(),
                  scheme: item.scheme || ""
                });
              }
            }
          }
        }
      }
      if (topics.length > 0) {
        console.log(`Axios Weibo API successfully fetched ${topics.length} topics.`);
      }
    } catch (err: any) {
      console.error("Axios Weibo API failed:", err.message);
    }

    // 2. Secondary Source: Puppeteer Scraper for s.weibo.com (Fallback)
    if (topics.length === 0) {
      console.log("Axios failed, starting Puppeteer for s.weibo.com Hot Search...");
      let browser;
      try {
        browser = await puppeteer.launch({
          headless: true,
          args: [
            "--no-sandbox", 
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu"
          ],
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
        });
        const page = await browser.newPage();
        
        // Use Desktop Hot Search page
        let hotSearchUrl = "https://s.weibo.com/top/summary";
        if (category === "entertainment") {
          hotSearchUrl = "https://s.weibo.com/top/summary?cate=entrank";
        } else if (category === "social") {
          hotSearchUrl = "https://s.weibo.com/top/summary?cate=socialevent";
        } else if (category === "realtime") {
          hotSearchUrl = "https://s.weibo.com/top/summary?cate=realtimehot";
        } else if (category === "life") {
          hotSearchUrl = "https://s.weibo.com/top/summary?cate=life";
        }

        console.log(`Puppeteer navigating to: ${hotSearchUrl}`);
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        await page.goto(hotSearchUrl, { waitUntil: "networkidle2", timeout: 30000 });
        
        // Wait for the table to load
        await page.waitForSelector(".td-02", { timeout: 10000 }).catch(() => console.log("Timeout waiting for .td-02"));

        const scrapedTopics = await page.evaluate(() => {
          const items: any[] = [];
          const rows = document.querySelectorAll("tr");
          rows.forEach(row => {
            const titleEl = row.querySelector(".td-02 a");
            const rankEl = row.querySelector(".td-01");
            const iconEl = row.querySelector(".td-03");
            
            if (titleEl) {
              const title = titleEl.textContent?.trim() || "";
              const href = titleEl.getAttribute("href") || "";
              const isTop = rankEl?.textContent?.includes("置顶") || iconEl?.textContent?.includes("荐");
              
              if (title && !isTop) {
                items.push({
                  title: title,
                  query: title,
                  scheme: href.startsWith("http") ? href : `https://s.weibo.com${href}`
                });
              }
            }
          });
          return items;
        });
        
        if (scrapedTopics.length > 0) {
          topics = scrapedTopics;
          console.log(`Puppeteer (s.weibo.com) successfully scraped ${topics.length} topics.`);
        }
      } catch (err: any) {
        console.error("Puppeteer s.weibo.com scrape failed:", err.message);
      } finally {
        if (browser) await browser.close();
      }
    }

    // 3. Last Resort: Puppeteer Scraper for TopHub (Fallback)
    if (topics.length === 0) {
      console.log("s.weibo.com failed, trying TopHub via Puppeteer...");
      let browser;
      try {
        browser = await puppeteer.launch({
          headless: true,
          args: ["--no-sandbox", "--disable-setuid-sandbox"],
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
        });
        const page = await browser.newPage();
        
        let tophubUrl = "https://tophub.today/n/Kq6bwaO0el"; // General
        if (category === "entertainment") {
          tophubUrl = "https://tophub.today/n/3QeLwJEd7k";
        } else if (category === "social") {
          tophubUrl = "https://tophub.today/n/74Kvx59dkx";
        } else if (category === "life") {
          tophubUrl = "https://tophub.today/n/Kq6bwaO0el"; // Life usually in general or specific node
        }

        console.log(`Puppeteer navigating to TopHub: ${tophubUrl}`);
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        await page.goto(tophubUrl, { waitUntil: "networkidle2", timeout: 30000 });
        
        const scrapedTopics = await page.evaluate(() => {
          const items: any[] = [];
          const rows = document.querySelectorAll(".node-list tbody tr");
          rows.forEach(row => {
            const titleEl = row.querySelector("td.al a");
            if (titleEl) {
              const title = titleEl.textContent?.trim() || "";
              const href = titleEl.getAttribute("href") || "";
              if (title && !title.includes("置顶")) {
                items.push({
                  title: title,
                  query: title,
                  tophubLink: href.startsWith("http") ? href : `https://tophub.today${href}`
                });
              }
            }
          });
          return items;
        });
        
        if (scrapedTopics.length > 0) {
          topics = scrapedTopics;
          console.log(`Puppeteer (TopHub) successfully scraped ${topics.length} topics.`);
        }
      } catch (err: any) {
        console.error("Puppeteer TopHub scrape failed:", err.message);
      } finally {
        if (browser) await browser.close();
      }
    }

    // 4. Final Fallback: Weibo Direct APIs (Already tried as #1, but keeping logic for structure)
    if (topics.length === 0) {
      console.log("All sources failed.");
    }

    if (topics.length === 0) {
      console.log("All live crawls failed, no topics found.");
    }

    // Deduplicate by title
    const uniqueTopics = Array.from(new Map(topics.map(t => [t.title, t])).values());
    
    console.log(`Successfully extracted ${uniqueTopics.length} unique topics`);
    
    if (uniqueTopics.length === 0) {
      return res.status(404).json({ message: "Không tìm thấy tin nào từ Weibo Mobile" });
    }

    const topTopics = uniqueTopics.slice(0, 5);

    // Return original topics without translation
    const finalTopics = topTopics.map(t => ({ ...t, originalTitle: t.title }));
    res.json(finalTopics);
  } catch (error: any) {
    console.error("Crawl error:", error.message);
    res.status(500).json({ message: "Lỗi hệ thống khi crawl Weibo: " + error.message });
  }
});

app.post(["/api/rewrite", "/api/rewrite/"], async (req, res) => {
  const { title, query, scheme } = req.body;
  if (!title && !query) return res.status(400).json({ message: "Title or Query is required" });

  try {
    let rawContent = "";
    let mblogId = "";
    let images: string[] = [];

    // 1. Thử trích xuất mblogid trực tiếp từ scheme (Cách chính xác nhất)
    if (scheme) {
      const idMatch = scheme.match(/mblogid=([A-Za-z0-9]+)/) || scheme.match(/status\/([A-Za-z0-9]+)/);
      if (idMatch) {
        mblogId = idMatch[1];
      }
    }

    // 2. Nếu có mblogId, gọi API lấy chi tiết bài viết (Rất ổn định)
    if (mblogId) {
      console.log(`Fetching direct post content for ID: ${mblogId}`);
      try {
        const detailUrl = `https://m.weibo.cn/statuses/show?id=${mblogId}`;
        const response = await axios.get(detailUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
            "Referer": `https://m.weibo.cn/detail/${mblogId}`,
            "X-Requested-With": "XMLHttpRequest"
          },
          timeout: 8000
        });

        if (response.data && response.data.data) {
          const postData = response.data.data;
          rawContent = postData.longText?.content || postData.text || "";
          
          // Extract images from direct API
          if (postData.pics) {
            images = postData.pics.map((p: any) => p.large?.url || p.url);
          }
        }
      } catch (err: any) {
        console.warn(`Direct fetch failed for ${mblogId}, falling back to search...`);
      }
    }

    // 3. Sử dụng Axios API search (Nhanh và ổn định hơn Puppeteer)
    if (!rawContent && query) {
      console.log(`Trying Axios API search for query: ${query}`);
      try {
        const encodedQuery = encodeURIComponent(query).replace(/%20/g, "+");
        const apiSearchUrl = `https://m.weibo.cn/api/container/getIndex?containerid=100103type%3D1%26q%3D${encodedQuery}`;
        
        const apiRes = await axios.get(apiSearchUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
            "Referer": "https://m.weibo.cn/",
            "X-Requested-With": "XMLHttpRequest"
          },
          timeout: 10000
        });

        if (apiRes.data && apiRes.data.data && apiRes.data.data.cards) {
          const findContentInCards = (cards: any[]): any => {
            for (const card of cards) {
              const group = card.card_group || card.group || (card.card_type === 11 ? [card] : []);
              if (Array.isArray(group)) {
                for (const item of group) {
                  if (item.mblog) {
                    return {
                      text: item.mblog.longText?.content || item.mblog.text || "",
                      pics: item.mblog.pics?.map((p: any) => p.large?.url || p.url) || []
                    };
                  }
                }
              } else if (card.mblog) {
                return {
                  text: card.mblog.longText?.content || card.mblog.text || "",
                  pics: card.mblog.pics?.map((p: any) => p.large?.url || p.url) || []
                };
              }
            }
            return null;
          };
          const res = findContentInCards(apiRes.data.data.cards);
          if (res) {
            rawContent = res.text;
            images = res.pics || [];
            console.log(`Axios API Search: Found content and ${images.length} images`);
          }
        }
      } catch (err: any) {
        console.warn("Axios API search failed:", err.message);
      }
    }

    // 4. Sử dụng Puppeteer để lấy nội dung (Phương án dự phòng cuối cùng)
    if (!rawContent && query) {
      console.log(`Starting Puppeteer fallback for query: ${query}`);
      let browser;
      try {
        browser = await puppeteer.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
          ],
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
        });

        const page = await browser.newPage();
        
        // Giả lập iPhone để vào trang mobile
        await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1");
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

        const encodedQuery = encodeURIComponent(query).replace(/%20/g, "+");
        const containerId = `100103type=1&q=${encodedQuery}`;
        const scrapingUrl = `https://m.weibo.cn/search?containerid=${encodeURIComponent(containerId)}`;

        console.log(`Puppeteer navigating to: ${scrapingUrl}`);
        
        // Đặt timeout dài hơn vì Weibo load khá chậm
        await page.goto(scrapingUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // Đợi một chút để JS render hoàn toàn
        await new Promise(r => setTimeout(r, 3000));

        // 1. Thử lấy từ $render_data trong script (Cách sạch nhất)
        const renderDataContent = await page.evaluate(() => {
          try {
            // @ts-ignore
            const data = window.$render_data;
            if (!data) return null;

            const findContent = (obj: any): any => {
              if (!obj) return null;
              if (obj.mblog) {
                return {
                  text: obj.mblog.longText?.content || obj.mblog.text || "",
                  pics: obj.mblog.pics?.map((p: any) => p.large?.url || p.url) || []
                };
              }
              if (Array.isArray(obj)) {
                for (const item of obj) {
                  const c = findContent(item);
                  if (c) return c;
                }
              }
              if (typeof obj === 'object') {
                for (const key in obj) {
                  const c = findContent(obj[key]);
                  if (c) return c;
                }
              }
              return null;
            };
            return findContent(data);
          } catch (e) {
            return null;
          }
        });

        if (renderDataContent) {
          rawContent = renderDataContent.text;
          images = renderDataContent.pics || [];
          console.log(`Puppeteer: Found content and ${images.length} images in $render_data`);
        }

        // 2. Nếu không thấy, thử lấy text từ các selector phổ biến
        if (!rawContent) {
          console.log("Puppeteer: Checking for content in common selectors...");
          const extracted = await page.evaluate(async () => {
            const selectors = ["article", ".card", ".weibo-main"];
            for (const selector of selectors) {
              const elements = document.querySelectorAll(selector);
              for (const el of Array.from(elements)) {
                const textEl = el.querySelector(".weibo-text") || el.querySelector(".content") || el.querySelector(".txt") || el;
                const text = textEl.textContent?.trim() || "";
                if (text.length < 30) continue;

                // Find images in 'article ul' or common media containers
                const pics: string[] = [];
                const mediaContainers = el.querySelectorAll("ul, .weibo-media, .weibo-media-wraps, .media-piclist");
                mediaContainers.forEach(container => {
                  const imgEls = container.querySelectorAll("img");
                  imgEls.forEach(img => {
                    const src = img.getAttribute("src");
                    if (src && !src.includes("avatar") && !src.includes("icon")) {
                      // Convert to large image URL
                      pics.push(src.replace("/thumb180/", "/large/").replace("/orj360/", "/large/").replace("/wap180/", "/large/"));
                    }
                  });
                });

                // If no ul images found, try any img in the article that looks like a post image
                if (pics.length === 0) {
                  const allImgs = el.querySelectorAll("img");
                  allImgs.forEach(img => {
                    const src = img.getAttribute("src");
                    if (src && (src.includes("sinaimg.cn") || src.includes("weibo.cn")) && !src.includes("avatar") && !src.includes("icon")) {
                      pics.push(src.replace("/thumb180/", "/large/").replace("/orj360/", "/large/").replace("/wap180/", "/large/"));
                    }
                  });
                }

                // Check for "全文" (Full Text) link and try to expand
                const links = Array.from(el.querySelectorAll("a"));
                const fullTextA = links.find(a => a.textContent?.includes("全文"));
                
                if (fullTextA) {
                  const href = fullTextA.getAttribute("href");
                  if (href && (href.includes("status/") || href.includes("detail/"))) {
                    return { navigateTo: href };
                  }
                }
                
                return { text, pics };
              }
            }
            return null;
          });

          if (extracted) {
            if (extracted.navigateTo) {
              const detailUrl = extracted.navigateTo.startsWith("http") 
                ? extracted.navigateTo 
                : `https://m.weibo.cn${extracted.navigateTo}`;
              console.log(`Puppeteer: Found "Full Text" link, navigating to: ${detailUrl}`);
              await page.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 20000 });
              await new Promise(r => setTimeout(r, 2000));
              
              const detailResult = await page.evaluate(() => {
                const article = document.querySelector("article") || document.querySelector(".weibo-main") || document.body;
                const textEl = article.querySelector(".weibo-text") || article.querySelector(".content") || article.querySelector(".main-text") || article;
                
                // Extract images from 'article ul'
                const pics: string[] = [];
                const mediaContainers = article.querySelectorAll("ul, .weibo-media, .weibo-media-wraps, .media-piclist");
                mediaContainers.forEach(container => {
                  const imgEls = container.querySelectorAll("img");
                  imgEls.forEach(img => {
                    const src = img.getAttribute("src");
                    if (src && !src.includes("avatar") && !src.includes("icon")) {
                      pics.push(src.replace("/thumb180/", "/large/").replace("/orj360/", "/large/").replace("/wap180/", "/large/"));
                    }
                  });
                });

                // Fallback to any images in article
                if (pics.length === 0) {
                  const imgEls = article.querySelectorAll("img");
                  imgEls.forEach(img => {
                    const src = img.getAttribute("src");
                    if (src && (src.includes("sinaimg.cn") || src.includes("weibo.cn")) && !src.includes("avatar") && !src.includes("icon")) {
                      pics.push(src.replace("/thumb180/", "/large/").replace("/orj360/", "/large/").replace("/wap180/", "/large/"));
                    }
                  });
                }

                // Clone to remove "收起" or other links
                const clone = textEl.cloneNode(true) as HTMLElement;
                clone.querySelectorAll("a, .expand").forEach(e => e.remove());
                const text = clone.textContent?.trim() || "";
                
                return { text, pics };
              });

              if (detailResult) {
                rawContent = detailResult.text;
                images = detailResult.pics || [];
              }
            } else if (extracted.text) {
              rawContent = extracted.text;
              images = extracted.pics || [];
            }
          }
          
          if (rawContent) console.log("Puppeteer: Found content via CSS selectors (with expansion check)");
        }

        // 3. Fallback sang Desktop Search nếu Mobile thất bại
        if (!rawContent) {
          const desktopSearchUrl = `https://s.weibo.com/weibo?q=${encodedQuery}&Refer=index`;
          console.log(`Puppeteer: Mobile failed, trying Desktop Search: ${desktopSearchUrl}`);
          
          await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
          await page.setViewport({ width: 1280, height: 800 });
          
          await page.goto(desktopSearchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
          await new Promise(r => setTimeout(r, 2000));

          const desktopResult = await page.evaluate(() => {
            const elements = document.querySelectorAll(".card-feed .content .txt");
            for (const el of Array.from(elements)) {
              const card = el.closest(".card");
              const pics: string[] = [];
              if (card) {
                const imgEls = card.querySelectorAll(".media-piclist img");
                imgEls.forEach(img => {
                  const src = img.getAttribute("src");
                  if (src) {
                    pics.push(src.replace("/thumb180/", "/large/").replace("/orj360/", "/large/"));
                  }
                });
              }

              // Loại bỏ 收起/全文
              const clones = el.cloneNode(true) as HTMLElement;
              clones.querySelectorAll("a").forEach(a => {
                if (a.textContent?.includes("收起") || a.textContent?.includes("全文")) a.remove();
              });
              const text = clones.textContent?.trim() || "";
              if (text.length > 30) return { text, pics };
            }
            return null;
          });

          if (desktopResult) {
            rawContent = desktopResult.text;
            images = desktopResult.pics || [];
            console.log(`Puppeteer: Found content and ${images.length} images via Desktop Search`);
          }
        }

      } catch (puppeteerErr: any) {
        console.error("Puppeteer error:", puppeteerErr.message);
      } finally {
        if (browser) await browser.close();
      }
    }

    // 4. Fallback cuối cùng: Axios (Nếu Puppeteer thất bại hoặc không lấy được gì)
    if (!rawContent && query) {
      console.log("Puppeteer failed or empty, falling back to Axios Scraping...");
      try {
        const encodedQuery = encodeURIComponent(query).replace(/%20/g, "+");
        
        // Try API search first (more stable than HTML scraping)
        const apiSearchUrl = `https://m.weibo.cn/api/container/getIndex?containerid=100103type%3D1%26q%3D${encodedQuery}`;
        console.log(`Trying Axios API search: ${apiSearchUrl}`);
        const apiRes = await axios.get(apiSearchUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
            "Referer": "https://m.weibo.cn/",
            "X-Requested-With": "XMLHttpRequest"
          },
          timeout: 10000
        });

        if (apiRes.data && apiRes.data.data && apiRes.data.data.cards) {
          const findContentInCards = (cards: any[]): any => {
            for (const card of cards) {
              const group = card.card_group || card.group || (card.card_type === 11 ? [card] : []);
              if (Array.isArray(group)) {
                for (const item of group) {
                  if (item.mblog) {
                    return {
                      text: item.mblog.longText?.content || item.mblog.text || "",
                      pics: item.mblog.pics?.map((p: any) => p.large?.url || p.url) || []
                    };
                  }
                }
              } else if (card.mblog) {
                return {
                  text: card.mblog.longText?.content || card.mblog.text || "",
                  pics: card.mblog.pics?.map((p: any) => p.large?.url || p.url) || []
                };
              }
            }
            return null;
          };
          const res = findContentInCards(apiRes.data.data.cards);
          if (res) {
            rawContent = res.text;
            images = res.pics || [];
            console.log(`Axios: Found content and ${images.length} images via API search`);
          }
        }

        if (!rawContent) {
          const containerId = `100103type=1&q=${encodedQuery}`;
          const scrapingUrl = `https://m.weibo.cn/search?containerid=${encodeURIComponent(containerId)}`;
          console.log(`Trying Axios HTML scraping: ${scrapingUrl}`);
        
        const response = await axios.get(scrapingUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
            "Referer": "https://m.weibo.cn/",
            "X-Requested-With": "XMLHttpRequest"
          },
          timeout: 15000
        });

        const html = response.data;
        if (typeof html === 'string') {
          const patterns = [
            /var\s+\$render_data\s*=\s*(\[[\s\S]*?\])\s*\[0\]/,
            /var\s+\$render_data\s*=\s*(\[[\s\S]*?\])/,
            /window\.\$render_data\s*=\s*(\[[\s\S]*?\])/
          ];

          for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match) {
              try {
                const renderData = JSON.parse(match[1]);
                const findContent = (obj: any): string => {
                  if (!obj) return "";
                  if (obj.mblog) return obj.mblog.longText?.content || obj.mblog.text || "";
                  if (Array.isArray(obj)) {
                    for (const item of obj) {
                      const c = findContent(item);
                      if (c) return c;
                    }
                  }
                  if (typeof obj === 'object') {
                    for (const key in obj) {
                      const c = findContent(obj[key]);
                      if (c) return c;
                    }
                  }
                  return "";
                };
                rawContent = findContent(renderData);
                if (rawContent) break;
              } catch (e) {}
            }
          }

          if (!rawContent) {
            const $ = cheerio.load(html);
            $("article").each((i, article) => {
              const textEl = $(article).find(".weibo-text, .content, .txt").first();
              const text = textEl.text().trim();
              if (text.length > 30) {
                rawContent = text;
                // Extract images from ul
                $(article).find("ul img, .weibo-media img, .media-piclist img").each((j, img) => {
                  const src = $(img).attr("src");
                  if (src && !src.includes("avatar") && !src.includes("icon")) {
                    images.push(src.replace("/thumb180/", "/large/").replace("/orj360/", "/large/").replace("/wap180/", "/large/"));
                  }
                });
                return false;
              }
            });
          }
        }
      }
    } catch (axiosErr: any) {
        console.error("Axios fallback failed:", axiosErr.message);
      }
    }

    if (rawContent) {
      rawContent = rawContent.replace(/<br \/>/g, "\n").replace(/<[^>]*>/g, "").trim();
    }

    const content = rawContent || "";
    res.json({ content, images });
  } catch (error: any) {
    console.error("Rewrite/Crawl error:", error.message);
    res.status(500).json({ message: "Lỗi khi lấy nội dung: " + error.message });
  }
});

app.get(["/api/posts", "/api/posts/"], async (req, res) => {
  try {
    if (isPostgres) {
      const result = await db.query("SELECT * FROM posts ORDER BY created_at DESC");
      res.json(result.rows);
    } else {
      const posts = db.prepare("SELECT * FROM posts ORDER BY created_at DESC").all();
      res.json(posts);
    }
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

app.post(["/api/posts", "/api/posts/"], async (req, res) => {
  const { original_title, rewritten_content, image_url } = req.body;
  console.log(`Saving post: ${original_title}`);
  try {
    if (isPostgres) {
      const result = await db.query(
        "INSERT INTO posts (original_title, rewritten_content, image_url) VALUES ($1, $2, $3) ON CONFLICT (original_title) DO UPDATE SET rewritten_content = $2, image_url = $3 RETURNING id",
        [original_title, rewritten_content, image_url]
      );
      res.json({ id: result.rows[0].id });
    } else {
      const info = db.prepare("INSERT INTO posts (original_title, rewritten_content, image_url) VALUES (?, ?, ?)").run(original_title, rewritten_content, image_url);
      console.log(`Post saved with ID: ${info.lastInsertRowid}`);
      res.json({ id: info.lastInsertRowid });
    }
  } catch (error: any) {
    if (error.code === 'SQLITE_CONSTRAINT' || error.code === '23505') {
      console.warn(`Post already exists: ${original_title}`);
      res.status(409).json({ message: "Post already exists" });
    } else {
      console.error(`Database error: ${error.message}`);
      res.status(500).json({ message: error.message });
    }
  }
});

app.delete(["/api/posts", "/api/posts/"], async (req, res) => {
  try {
    if (isPostgres) {
      await db.query("DELETE FROM posts");
    } else {
      db.prepare("DELETE FROM posts").run();
    }
    res.json({ message: "All posts deleted" });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

app.delete(["/api/posts/:id", "/api/posts/:id/"], async (req, res) => {
  try {
    if (isPostgres) {
      await db.query("DELETE FROM posts WHERE id = $1", [req.params.id]);
    } else {
      db.prepare("DELETE FROM posts WHERE id = ?").run(req.params.id);
    }
    res.json({ message: "Post deleted" });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

app.patch(["/api/posts/:id", "/api/posts/:id/"], async (req, res) => {
  const { id } = req.params;
  const { image_url } = req.body;
  try {
    if (isPostgres) {
      await db.query("UPDATE posts SET image_url = $1 WHERE id = $2", [image_url, id]);
    } else {
      db.prepare("UPDATE posts SET image_url = ? WHERE id = ?").run(image_url, id);
    }
    res.json({ message: "Post updated" });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

// Proxy image route to bypass Weibo hotlinking protection
app.get("/api/proxy-image", async (req, res) => {
  const imageUrl = req.query.url as string;
  if (!imageUrl) {
    return res.status(400).send("Missing image URL");
  }

  try {
    const response = await axios({
      url: imageUrl,
      method: 'GET',
      responseType: 'arraybuffer',
      headers: {
        'Referer': 'https://weibo.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 10000
    });

    const contentType = response.headers['content-type'] || 'image/jpeg';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
    res.send(response.data);
  } catch (error: any) {
    console.error(`Proxy image error for ${imageUrl}:`, error.message);
    res.status(500).send("Failed to fetch image");
  }
});

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Global error handler caught:", err.stack);
  res.status(500).json({ 
    error: "Internal Server Error", 
    message: err.message,
    path: req.path
  });
});

async function startServer() {
  try {
    // Ensure database is initialized before starting server
    await initDb();
    
    if (process.env.NODE_ENV !== "production") {
      console.log("Starting Vite in middleware mode...");
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } else {
      console.log("Serving static files from dist...");
      const distPath = path.join(process.cwd(), "dist");
      app.use(express.static(distPath));
      app.get("*", (req, res) => {
        res.sendFile(path.join(distPath, "index.html"));
      });
    }

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err: any) {
    if (err.message && err.message.includes("ENETUNREACH")) {
      console.error("CRITICAL: Failed to connect to database (ENETUNREACH). This often happens when trying to connect to a Supabase IPv6 address from an environment that only supports IPv4.");
      console.error("HINT: Try using the IPv4-only connection string from Supabase (usually available in their settings) or add '?sslmode=require' to your DATABASE_URL.");
    }
    console.error("CRITICAL: Failed to start server:", err);
    process.exit(1);
  }
}

startServer();
