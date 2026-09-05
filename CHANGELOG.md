# Changelog

## 1.0.0

- 从 VVV fixed133 中独立提取 CardVault。
- 改为 GitHub/SillyTavern 第三方扩展仓库结构。
- `auto_update` 开启。
- 设置模板改用 `import.meta.url` 加载，GitHub 仓库目录名变化也能工作。
- 保留现有 VVV CardVault 同源代理自动复用。
- 增加无 VVV 服务端插件时的 CardVault API 直连登录。
- 取消“酒馆账号硬编码权限表”对独立扩展的隐藏限制，改为扩展内选择云端账号。
- 直连模式只保存 token，不保存密码。
- 0-32 服务器伴随档案不可用时降级为普通 CardVault 归档，不再中止角色归档。
