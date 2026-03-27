import { useState, useEffect } from 'react';
import { RefreshCw, Copy, Trash2, ExternalLink, Flame, CheckCircle2, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface Post {
  id: number;
  original_title: string;
  rewritten_content: string;
  image_url?: string;
  created_at: string;
  status: string;
}

export default function App() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(false);
  const [crawling, setCrawling] = useState(false);
  const [category, setCategory] = useState('entertainment');
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch posts from our backend
  const fetchPosts = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/posts');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.message || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setPosts(data);
    } catch (err: any) {
      console.error('Failed to fetch posts', err);
      setError(`Không thể tải danh sách bài viết: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const rewriteWithAI = async (title: string, query?: string, scheme?: string) => {
    try {
      const res = await fetch('/api/rewrite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, query, scheme })
      });
      
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || 'Failed to rewrite with OpenRouter');
      }
      
      const data = await res.json();
      return { content: data.content, images: data.images || [] };
    } catch (err: any) {
      console.error('Rewrite error:', err);
      return { content: `[Lỗi AI: ${err.message || 'Unknown'}] ${title}`, images: [] };
    }
  };

  const handleCrawl = async () => {
    setCrawling(true);
    setError(null);
    console.log(`Starting crawl process via Weibo Mobile API for category: ${category}...`);
    
    try {
      // Step 0: Check server health before starting
      let healthOk = false;
      let retries = 0;
      while (!healthOk && retries < 5) {
        try {
          const healthRes = await fetch('/api/health');
          if (healthRes.ok) {
            const healthData = await healthRes.json();
            if (healthData.status === 'ok') {
              healthOk = true;
              break;
            }
          }
        } catch (e) {
          console.warn("Health check failed, server might be starting...");
        }
        retries++;
        await new Promise(r => setTimeout(r, 2000));
      }

      if (!healthOk) {
        throw new Error("Server chưa sẵn sàng. Vui lòng đợi giây lát và thử lại.");
      }

      // Step 1: Fetch latest hot topics from our backend (which crawls Weibo Mobile)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000); // 120s timeout
      
      const response = await fetch(`/api/crawl?category=${category}`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      
      const contentType = response.headers.get("content-type");
      if (!response.ok) {
        let errorMessage = 'Failed to crawl Weibo Mobile';
        if (contentType && contentType.includes("application/json")) {
          const errorData = await response.json();
          errorMessage = errorData.message || errorMessage;
        } else {
          const text = await response.text();
          console.error("Non-JSON error response:", text.substring(0, 200));
          errorMessage = `Server error (${response.status}). Vui lòng thử lại sau.`;
        }
        throw new Error(errorMessage);
      }

      if (!contentType || !contentType.includes("application/json")) {
        const text = await response.text();
        console.error("Expected JSON but got:", text.substring(0, 200));
        throw new Error("Server trả về định dạng không hợp lệ (không phải JSON).");
      }

      const topics: { title: string, query?: string, scheme?: string }[] = await response.json();
      
      if (topics.length === 0) {
        throw new Error('Không tìm thấy tin nào từ Weibo Mobile');
      }

      console.log(`Found ${topics.length} topics. Processing...`);

      // Step 2: Process each topic
      let successCount = 0;
      for (const item of topics) {
        try {
          // Thêm delay nhỏ để tránh bị Weibo chặn
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          const { content, images } = await rewriteWithAI(item.title, item.query, item.scheme);
          
          const saveRes = await fetch('/api/posts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              original_title: item.title, 
              rewritten_content: content,
              image_url: JSON.stringify(images)
            })
          });
          
          if (saveRes.ok || saveRes.status === 409) {
            successCount++;
          }
        } catch (itemErr) {
          console.error(`Failed to process topic: ${item.title}`, itemErr);
        }
      }
      
      console.log(`Successfully processed ${successCount} topics.`);
      if (successCount === 0) {
        setError("Tất cả các chủ đề đều đã tồn tại hoặc gặp lỗi khi lưu.");
      }

      await fetchPosts();
    } catch (err: any) {
      console.error('Crawl failed', err);
      let msg = err.message || 'Không xác định';
      if (err.name === 'AbortError' || msg.includes('aborted')) {
        msg = "Quá trình lấy tin tốn quá nhiều thời gian (Timeout). Vui lòng thử lại sau.";
      }
      setError(`Lỗi hệ thống: ${msg}`);
    } finally {
      setCrawling(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await fetch(`/api/posts/${id}`, { method: 'DELETE' });
      setPosts(posts.filter(p => p.id !== id));
    } catch (err) {
      console.error('Delete failed', err);
    }
  };

  const handleDeleteAll = async () => {
    try {
      await fetch('/api/posts', { method: 'DELETE' });
      setPosts([]);
    } catch (err) {
      console.error('Delete all failed', err);
    }
  };

  const copyToClipboard = (text: string, id: number) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  useEffect(() => {
    fetchPosts();
  }, []);

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] font-sans">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-white border-b border-gray-200 px-6 py-4 flex justify-between items-center shadow-sm">
        <div className="flex items-center gap-2">
          <div className="bg-red-500 p-2 rounded-lg">
            <Flame className="text-white w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Cbiz Auto Content</h1>
            <p className="text-xs text-gray-500 uppercase tracking-widest font-semibold">Weibo Hot Search Tracker</p>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {posts.length > 0 && (
            <button 
              onClick={handleDeleteAll}
              className="flex items-center gap-2 px-4 py-2 rounded-full font-medium text-red-600 hover:bg-red-50 transition-all border border-red-100"
            >
              <Trash2 className="w-4 h-4" />
              Xoá tất cả
            </button>
          )}
          
          <button 
            onClick={handleCrawl}
            disabled={crawling}
            className={`flex items-center gap-2 px-4 py-2 rounded-full font-medium transition-all ${
              crawling 
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed' 
              : 'bg-black text-white hover:bg-gray-800 active:scale-95 shadow-lg shadow-black/10'
            }`}
          >
            <RefreshCw className={`w-4 h-4 ${crawling ? 'animate-spin' : ''}`} />
            {crawling ? 'Đang quét & viết bài...' : 'Crawl ngay'}
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-6">
        {/* Category Selector */}
        <div className="flex items-center gap-2 mb-8 bg-white p-1.5 rounded-2xl border border-gray-200 w-fit shadow-sm overflow-x-auto">
          {[
            { id: 'entertainment', label: '🎬 Văn hoá - Giải trí (文娱榜)', color: 'text-purple-600 bg-purple-50 border-purple-100' },
            { id: 'realtime', label: '🔥 Xu hướng (热搜榜)', color: 'text-orange-600 bg-orange-50 border-orange-100' },
            { id: 'social', label: '🏠 Xã hội (社会榜)', color: 'text-blue-600 bg-blue-50 border-blue-100' },
            { id: 'life', label: '🌱 Đời sống (生活榜)', color: 'text-emerald-600 bg-emerald-50 border-emerald-100' }
          ].map((cat) => (
            <button
              key={cat.id}
              onClick={() => setCategory(cat.id)}
              className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-all ${
                category === cat.id 
                ? `${cat.color} border shadow-sm scale-[1.02]` 
                : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-600">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <p className="text-sm font-medium">{error}</p>
          </div>
        )}

        {loading && posts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 gap-4">
            <div className="w-8 h-8 border-4 border-black border-t-transparent rounded-full animate-spin"></div>
            <p className="text-gray-500 font-medium">Đang tải dữ liệu...</p>
          </div>
        ) : posts.length === 0 ? (
          <div className="text-center py-20 bg-white rounded-3xl border border-dashed border-gray-300">
            <p className="text-gray-400 mb-4">Chưa có bài viết nào. Hãy nhấn "Crawl ngay" để bắt đầu.</p>
          </div>
        ) : (
          <div className="grid gap-6">
            <AnimatePresence mode="popLayout">
              {posts.map((post) => (
                <motion.div
                  key={post.id}
                  layout
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="bg-white rounded-2xl border border-gray-200 overflow-hidden hover:shadow-md transition-shadow"
                >
                  <div className="p-6">
                    <div className="flex justify-between items-start mb-4">
                      <div className="flex-1">
                        <span className="inline-block px-2 py-1 bg-gray-100 text-[10px] font-bold text-gray-500 rounded uppercase tracking-wider mb-2">
                          Tiêu đề Hot Search
                        </span>
                        <h2 className="text-lg font-semibold text-gray-800 leading-tight">
                          {post.original_title}
                        </h2>
                      </div>
                      <div className="flex gap-2 ml-4">
                        <button 
                          onClick={() => {
                            const images = post.image_url ? JSON.parse(post.image_url) : [];
                            const imageNote = images.length > 0 ? `\n(Lưu ý: Bài gốc có ${images.length} ảnh, hãy tải về và đăng kèm bài viết).` : '';
                            const prompt = `Dịch tiêu đề và nội dung Weibo sau thành một bài đăng Facebook tiếng Việt hấp dẫn.\n\nYêu cầu:\n1. Phong cách: Drama, hóng hớt, lôi cuốn (kiểu các page tin tức Cbiz).\n2. Tên người Trung Quốc: BẮT BUỘC dịch sang âm Hán Việt (ví dụ: 赵露思 -> Triệu Lộ Tư).\n3. Cấu trúc: Tiêu đề gây sốc + Nội dung tóm tắt hấp dẫn + Hashtag liên quan.${imageNote}\n\nTiêu đề: ${post.original_title}\nNội dung: ${post.rewritten_content}`;
                            copyToClipboard(prompt, post.id + 10000);
                          }}
                          className={`flex items-center gap-2 px-3 py-2 rounded-xl font-bold text-xs transition-all ${
                            copiedId === post.id + 10000
                            ? 'bg-blue-100 text-blue-600' 
                            : 'bg-blue-600 text-white hover:bg-blue-700 shadow-md shadow-blue-200'
                          }`}
                          title="Copy Prompt cho AI"
                        >
                          {copiedId === post.id + 10000 ? <CheckCircle2 className="w-4 h-4" /> : <Flame className="w-4 h-4" />}
                          {copiedId === post.id + 10000 ? 'Đã copy Prompt' : 'Copy FB Prompt'}
                        </button>
                        <button 
                          onClick={() => copyToClipboard(post.rewritten_content, post.id)}
                          className={`p-2 rounded-xl transition-all ${
                            copiedId === post.id 
                            ? 'bg-green-100 text-green-600' 
                            : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                          }`}
                          title="Copy nội dung"
                        >
                          {copiedId === post.id ? <CheckCircle2 className="w-5 h-5" /> : <Copy className="w-5 h-5" />}
                        </button>
                        <button 
                          onClick={() => handleDelete(post.id)}
                          className="p-2 bg-red-50 text-red-500 rounded-xl hover:bg-red-100 transition-all"
                          title="Xoá bài"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      </div>
                    </div>

                    <div className="bg-gray-50 rounded-xl p-5 border border-gray-100 relative">
                      <span className="absolute -top-3 left-4 px-2 py-1 bg-black text-white text-[10px] font-bold rounded uppercase tracking-wider">
                        Nội dung gốc (Weibo)
                      </span>
                      <p className="whitespace-pre-wrap text-gray-700 leading-relaxed">
                        {post.rewritten_content || <span className="text-gray-400 italic">Không lấy được nội dung bài viết</span>}
                      </p>

                      {post.image_url && (
                        <div className="mt-4 grid grid-cols-3 gap-2">
                          {(() => {
                            try {
                              const images = JSON.parse(post.image_url);
                              if (Array.isArray(images) && images.length > 0) {
                                return images.map((img, idx) => (
                                  <div key={idx} className="relative aspect-square rounded-lg overflow-hidden border border-gray-200 bg-gray-100 group">
                                    <img 
                                      src={`/api/proxy-image?url=${encodeURIComponent(img)}`} 
                                      alt={`Weibo image ${idx + 1}`}
                                      className="w-full h-full object-cover transition-transform group-hover:scale-110"
                                    />
                                    <a 
                                      href={`/api/proxy-image?url=${encodeURIComponent(img)}`} 
                                      target="_blank" 
                                      rel="noopener noreferrer"
                                      className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity"
                                    >
                                      <ExternalLink className="text-white w-5 h-5" />
                                    </a>
                                  </div>
                                ));
                              }
                            } catch (e) {
                              console.error("Failed to parse images", e);
                            }
                            return null;
                          })()}
                        </div>
                      )}
                    </div>

                    <div className="mt-4 flex items-center justify-between text-[11px] text-gray-400 font-medium">
                      <div className="flex items-center gap-1">
                        <ExternalLink className="w-3 h-3" />
                        <span>Nguồn: Weibo / TopHub</span>
                      </div>
                      <span>{new Date(post.created_at).toLocaleString('vi-VN')}</span>
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </main>

      {/* Footer Info */}
      <footer className="max-w-5xl mx-auto p-6 text-center text-gray-400 text-xs border-t border-gray-100 mt-10">
        <p>© 2026 Cbiz Auto Content Tool • Powered by Miang994</p>
      </footer>
    </div>
  );
}
