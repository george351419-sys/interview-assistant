#!/bin/bash
# 面试助手 · 一键启动（真实服务）
cd "$(dirname "$0")" || exit 1

echo ""
echo "面试助手 - 环境自检"
node scripts/check.js

echo ""
read -r -p "启动服务？[Y/n] " ans
ans=${ans:-Y}
if [[ ! "$ans" =~ ^[Yy] ]]; then exit 0; fi

node server.js
