# Sử dụng Node.js phiên bản 20 làm base image
FROM node:20-slim

# Thiết lập thư mục làm việc trong container
WORKDIR /app

# Copy package.json và package-lock.json (nếu có)
COPY package*.json ./

# Cài đặt tất cả các dependencies
# Lưu ý: Cài cả devDependencies vì chúng ta cần 'tsx' để chạy server và 'vite' để build frontend
RUN npm install

# Copy toàn bộ mã nguồn vào container
COPY . .

# Biên dịch frontend (Vite sẽ tạo ra thư mục dist/)
RUN npm run build

# Mở cổng 3000 (cổng mặc định của ứng dụng)
EXPOSE 3001

# Thiết lập biến môi trường là production
ENV NODE_ENV=production

# Lệnh khởi chạy ứng dụng
CMD ["npm", "start"]