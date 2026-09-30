# CardVault · Full

这是完整功能版源码，基于用户提供的 `card-main` 源码修改。

## 功能

- **角色卡库**：保留上传、AI 分类、批量管理、自动导入酒馆等功能。
- **游玩备份**：保留角色 PNG、完整角色 JSON、聊天 JSONL、绑定世界书等归档 / 恢复功能。
- **不包含 Anima 世界书保存功能**：已移除 Anima 世界书页面、保存、查看、恢复、导出和删除逻辑。旧版本曾保存到浏览器 IndexedDB 的数据不会被本版本主动删除。

## AI 分类持久化

从 1.2.3 开始，CardVault 云端是 Full 与 Import-Only 两个版本共享分类的主存储。Full 会把当前账号的全部分类打包成一张内部 JSON 角色卡：

`__CardVault_AI_Classification_DB__card2`

并通过现有 `/api/cards/import` 保存到 CardVault，无需修改 CardVault 后端源码。插件自己的卡库列表会自动隐藏这张内部数据卡。

同时保留 SillyTavern `extension_settings` 与 `localStorage` 作为本机镜像 / 迁移来源。Import-Only 只读取云端分类数据库，不负责写入。

> 不要在 CardVault 网站后台手动删除名称以 `__CardVault_AI_Classification_DB__` 开头的内部数据卡；删除它会失去云端分类主副本。

## 悬浮球

悬浮球拖动松手后会吸进左 / 右屏幕边缘约 50%，仅露出半个球，减少遮挡。

## 安装

将本目录作为 SillyTavern 第三方扩展仓库根目录，至少保留：

```text
manifest.json
index.js
style.css
settings.html
```

然后通过 SillyTavern 的“扩展 → 安装扩展”使用 Git 仓库 URL 安装。

## 版本

### 1.2.4：移除 Anima 世界书保存

- 删除顶部 `Anima世界书` 页面。
- 删除 Anima 世界书 IndexedDB 保存 / 列表 / 详情 / 恢复 / 导出 / 删除代码。
- 保留角色卡库、游玩备份、云端永久 AI 分类共享和半隐藏吸边悬浮球。
- 不主动清理旧版本已经写入浏览器 IndexedDB 的历史 Anima 数据，避免静默删除用户数据。

### 1.2.3：分类同步到 CardVault + 悬浮球半隐藏吸边

- AI 分类通过隐藏内部角色卡同步到 CardVault 云端，无需改后端。
- 首次启动会自动迁移已有本地分类到云端。
- 悬浮球改为左右边缘半隐藏吸附。

- 浏览角色卡时，从详情返回会精确停留在打开该角色卡之前的滚动位置。
