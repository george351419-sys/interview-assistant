# 腾讯云主机 + EdgeOne 部署

本方案让 Node 服务常驻腾讯云主机，EdgeOne 为 `interview.playmath.cn` 提供 HTTPS 入口并转发 WebSocket。主域名 `playmath.cn` 的现有解析不需要修改。

## 1. 准备主机

创建一台 Ubuntu 22.04/24.04 腾讯云主机并分配公网 IPv4。安全组只需开放：

- TCP 22：SSH 管理，来源限制为你自己的公网 IP。
- TCP 80：EdgeOne HTTP 回源。

不要开放应用端口 8787；应用只监听本机回环地址后面的 Nginx。

SSH 登录主机后安装 Node.js 20、Nginx 和 Git：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

确认 Node 版本为 20.x。

## 2. 下载并安装应用

```bash
sudo useradd --system --home-dir /opt/interview-assistant --shell /usr/sbin/nologin interview-assistant
sudo git clone --branch main https://github.com/george351419-sys/interview-assistant.git /opt/interview-assistant
sudo chown -R interview-assistant:interview-assistant /opt/interview-assistant
sudo -u interview-assistant mkdir -p /opt/interview-assistant/data/history
sudo -u interview-assistant npm ci --prefix /opt/interview-assistant
```

创建生产环境密钥文件：

```bash
sudo install -m 600 -o root -g root /dev/null /etc/interview-assistant.env
sudo nano /etc/interview-assistant.env
```

填入以下内容，自己替换两项长随机值：

```ini
NODE_ENV=production
PORT=8787
APP_PASSWORD=设置一个仅用于登录面试助手的长密码
APP_SESSION_SECRET=设置另一条独立的长随机字符串
```

不要把 API Key 或简历写进 GitHub。登录后在配置台填写模型、ASR、JD 和简历；这些配置会保存在主机的 `data/config.json`。

安装并启动 systemd 服务：

```bash
sudo cp /opt/interview-assistant/deploy/tencent-cvm/interview-assistant.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now interview-assistant
sudo systemctl status interview-assistant --no-pager
```

## 3. 配置 Nginx

```bash
sudo cp /opt/interview-assistant/deploy/tencent-cvm/nginx.conf /etc/nginx/sites-available/interview-assistant
sudo ln -sfn /etc/nginx/sites-available/interview-assistant /etc/nginx/sites-enabled/interview-assistant
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

应用仅绑定到 `127.0.0.1:8787`，公网不能直接访问该端口。通过 Nginx/EdgeOne 进入。先在主机本地确认服务：

```bash
curl -i http://127.0.0.1:8787/api/health
curl -i -H 'Host: interview.playmath.cn' http://127.0.0.1/api/health
```

第一条应返回 JSON `{"ok":true,...}`；第二条也应返回健康状态。

## 4. 将子域名接入 EdgeOne

在腾讯云 EdgeOne 网站安全加速控制台添加加速域名 `interview.playmath.cn`：

- 源站类型：IP；源站地址：腾讯云主机公网 IPv4。
- 回源协议：HTTP；回源端口：80。
- 回源 Host：`interview.playmath.cn`。
- 为该域名配置 HTTPS 证书，并开启 HTTP 跳转 HTTPS。
- 为该域名启用 WebSocket，空闲超时设为 300 秒。
- `/ws`、`/api/*` 及登录相关请求不缓存。

按 EdgeOne 给出的目标值，在 `playmath.cn` 的 DNS 管理处只新增一条记录：`CNAME interview -> EdgeOne 分配的 CNAME`。不要改 `@`、`www` 或现有画屏域名记录。

确认解析生效后打开：

- `https://interview.playmath.cn/phone.html`
- `https://interview.playmath.cn/api/health`

访问页面会跳转到登录页。输入 `APP_PASSWORD` 后，再在配置台填写 LLM/ASR 配置。

## 更新版本

```bash
sudo -u interview-assistant git -C /opt/interview-assistant pull --ff-only
sudo -u interview-assistant npm ci --prefix /opt/interview-assistant
sudo systemctl restart interview-assistant
```

查看运行日志：

```bash
sudo journalctl -u interview-assistant -f
```

配置、简历和练习历史均存于主机 `data/` 目录。请定期安全备份该目录；不要公开分享备份文件。
