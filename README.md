# DesignKit AI - 电商AI出图工具

专为电商卖家打造的AI图片生成工具，一键生成白底主图、模特展示图、场景图等全套Listing素材。

## 功能特点

- 白底主图生成
- 模特展示图生成
- 场景图生成
- 余额查询
- 免费/付费模型切换

## 技术栈

- 前端：HTML + CSS + JavaScript
- 后端：Cloudflare Pages Functions
- AI API：SiliconFlow (Kwai-Kolors / Z-Image-Turbo)

## 部署到 Cloudflare Pages

### 1. 注册 Cloudflare
- 访问 https://dash.cloudflare.com
- 使用邮箱注册（免费）

### 2. 创建 Pages 项目
1. 登录后，点击左侧 **"Pages"**
2. 点击 **"Create a project"**
3. 选择 **"Connect to Git"**
4. 授权 GitHub 账号
5. 选择 `designkit-ai` 仓库
6. 点击 **"Begin setup"**

### 3. 配置构建设置
- **Project name**: designkit-ai（或您喜欢的名字）
- **Production branch**: main
- **Build command**:（留空，不填）
- **Build output directory**:（留空，不填）
- 点击 **"Save and Deploy"**

### 4. 设置环境变量（重要！）
1. 进入项目页面，点击 **"Settings"** → **"Environment variables"**
2. 点击 **"Add variables"**
3. 添加：
   - **Variable name**: `SILICONFLOW_API_KEY`
   - **Value**: `sk-hwbsmjcapqybradntfgvjukpmrqscmwrszrbaikddokdwteb`
4. 点击 **"Save"**
5. 重新部署：点击 **"Deployments"** → 找到最新部署 → 点击 **"Retry deployment"**

### 5. 访问网站
部署完成后，Cloudflare 会给您一个网址，例如：
```
https://designkit-ai.pages.dev
```

## 使用

1. 填写产品名称和卖点
2. 上传参考图（可选）
3. 选择生成类型
4. 点击"开始生成"

## 模型说明

- **免费模型 (Kolors)**: 适合模特展示图
- **付费模型 (Z-Image-Turbo)**: 适合白底产品图，效果更好

## 费用

- Z-Image-Turbo 约 0.005元/张
- 建议充值 2-5 元到 SiliconFlow
- 充值地址：https://cloud.siliconflow.cn/account/charge

## 文件结构

```
designkit-ai/
├── index.html              # 前端页面
├── functions/
│   └── api/
│       ├── generate.js     # 图片生成 API
│       └── balance.js      # 余额查询 API
├── package.json            # 项目配置
├── README.md               # 项目说明
└── .gitignore              # Git 忽略文件
```

## 注意事项

- Cloudflare Pages 免费版有每天 100,000 次请求限制
- Functions 每次执行最长时间 50ms（免费版）
- 图片生成 API 调用可能需要 5-15 秒，如果超时请重试
