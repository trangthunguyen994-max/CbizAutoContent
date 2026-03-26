# Cbiz Auto Content - Weibo Hot Search Tracker

Dự án tự động crawl tin tức từ Weibo Hot Search, dịch sang tiếng Việt (Hán Việt) và viết lại nội dung theo phong cách drama để đăng Facebook.

## Chạy dự án với Docker

Bạn có thể dễ dàng chạy dự án này ở local bằng Docker và Docker Compose.

### 1. Chuẩn bị
- Đảm bảo bạn đã cài đặt **Docker** và **Docker Compose**.
- Tạo file `.env` ở thư mục gốc (copy từ `.env.example`) và điền `NVIDIA_API_KEY` của bạn.

### 2. Chạy dự án
Mở terminal tại thư mục dự án và chạy lệnh:

```bash
docker-compose up --build
```

Dự án sẽ được build và khởi chạy tại địa chỉ: [http://localhost:3000](http://localhost:3000)

### 3. Các lệnh hữu ích
- **Dừng dự án:** `docker-compose down`
- **Chạy ngầm:** `docker-compose up -d`
- **Xem log:** `docker-compose logs -f`

## Cấu trúc dự án
- `server.ts`: Backend Express xử lý crawl và AI rewrite.
- `src/`: Frontend React + Vite + Tailwind CSS.
- `cbiz_content.db`: Cơ sở dữ liệu SQLite lưu trữ các bài viết.
- `Dockerfile` & `docker-compose.yml`: Cấu hình Docker.
