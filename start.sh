#!/bin/bash

# 1. AIモデルをダウンロード（起動時に実行）
# Qwen 1.5BをHugging Faceから直接取得するように設定
MODEL_URL="https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"
curl -L $MODEL_URL -o model.gguf

# 2. llama-serverをバックグラウンドで起動
llama-server -m model.gguf --port 11434 --host 0.0.0.0 &

# 3. サーバーが立ち上がるまで少し待機
sleep 10

# 4. Discord Botを起動
npm start