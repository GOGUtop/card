# 发布到 GitHub

先在 GitHub 新建一个空仓库，例如：

`CardVault-SillyTavern-Standalone`

然后在本目录执行：

```bash
git init
git add .
git commit -m "CardVault standalone 1.0.0"
git branch -M main
git remote add origin https://github.com/你的用户名/CardVault-SillyTavern-Standalone.git
git push -u origin main
```

发布完成后，SillyTavern 里的订阅/安装地址就是：

```text
https://github.com/你的用户名/CardVault-SillyTavern-Standalone
```

更新时只要提交新版本并推送到同一个仓库；同时递增 `manifest.json` 里的 `version`。
