# CardVault · SillyTavern Standalone

这是从 `fixed133` 中单独提取出来的 **CardVault 云端卡库**，已经整理成可直接放到 GitHub 仓库根目录、再由 SillyTavern 通过 Git 仓库 URL 安装/更新的第三方扩展。

## 保留的功能

- CardVault 云端角色卡浏览、搜索、封面懒加载
- 上传本地 PNG / JSON 角色卡
- 备份当前角色 / 批量备份全部角色
- 游玩备份（角色 PNG、完整角色 JSON、聊天 JSONL、卡内世界书、Scoped Regex、绑定世界书）
- 从 CardVault 恢复角色、聊天、世界书
- 批量恢复、同步当前角色并归还 CardVault
- 已归档世界书清理保护
- AI 角色卡分类（独立 OpenAI 兼容 API）
- 手机/桌面布局与原 CardVault 界面
- 原有导入守护逻辑
- 如果 0-32 桥存在，会继续尝试携带/恢复 0-32 伴随档案；如果不存在，不再阻止普通 CardVault 归档

## 独立版连接方式

1. **优先同源代理（默认开启）**
   - 如果当前 SillyTavern 仍装有原 VVV `vvv-theater-memory-server` CardVault 代理，会自动复用。
   - 浏览器不需要保存 CardVault 密码。

2. **独立直连**
   - 没检测到 VVV 代理时，直接连接设置里的 CardVault API 地址。
   - 输入云端账号和密码登录。
   - 密码不会写入扩展设置；仅保存服务端返回的登录 token。

> 如果 SillyTavern 页面是 HTTPS，而 CardVault API 仍是 HTTP，浏览器可能阻止“混合内容”。此时使用同源代理或给 CardVault API 配 HTTPS。

## GitHub 订阅安装

把本目录的文件放在 GitHub 仓库**根目录**，至少要有：

```text
manifest.json
index.js
style.css
settings.html
```

然后在 SillyTavern：

`扩展 → 安装扩展 → 粘贴 GitHub 仓库 URL`

例如：

```text
https://github.com/你的用户名/CardVault-SillyTavern-Standalone
```

`manifest.json` 已设置 `auto_update: true`，后续可通过 SillyTavern 扩展管理器检查更新。

## 从 fixed133 独立出来后的边界

这个仓库**不加载**：

- A 作者预设
- 作家审稿/作家记忆/问作者/平行世界
- AI 接力
- 0-32 主界面与小手机
- VVV 全域中枢

只保留 CardVault 本身。对 VVV/0-32 的调用都按“可选兼容桥”处理。

## 设置兼容

仍沿用扩展设置键：

```text
cardvault-sillytavern-extension
```

因此同一个 SillyTavern 用户下，从原 fixed133 迁移到独立版时，CardVault 的大部分本地设置（分类 API、分类结果、游玩备份映射等）可继续复用。

## 版本

- Standalone: `1.0.0`
- 提取源：VVV fixed133 CardVault `0.4.34-fixed79`
