# 1. ビルド環境（llama.cppをビルドする）
FROM node:20-slim AS builder
RUN apt-get update && apt-get install -y git build-essential cmake

# llama.cppをクローンしてビルド
RUN git clone https://github.com/ggerganov/llama.cpp && \
    cd llama.cpp && mkdir build && cd build && \
    cmake .. && cmake --build . --config Release -j$(nproc)

# 2. 実行環境
FROM node:20-slim
WORKDIR /app

# ビルドしたバイナリをコピー
COPY --from=builder /llama.cpp/build/bin/llama-server /usr/local/bin/

# プロジェクトファイルをコピー
COPY package*.json ./
RUN npm install
COPY . .

# 起動用スクリプトに実行権限を与える
RUN chmod +x start.sh

# ポートの開放（Hugging Faceのデフォルトは7860ですが、11434で内部通信します）
EXPOSE 7860

CMD ["./start.sh"]