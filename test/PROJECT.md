---
name: personal-blog-test-project
description: 用于验证 MyAgent 项目上下文加载的 Python 博客项目
---

# 项目概览

当前工作区中的示例项目位于 `project/`，目标是实现一个可部署、可维护的个人技术博客。
现阶段以需求澄清和开发计划为主，详细规划见 `project/doc/blog_project_plan.md`。

## 技术栈

- Python 3.11+
- Django 5.x 与 Django Admin
- 开发数据库使用 SQLite，生产数据库使用 PostgreSQL
- Django Templates、Bootstrap 5 和少量 JavaScript
- Markdown 使用 python-markdown，代码高亮使用 Pygments
- 部署使用 Gunicorn、Nginx、Docker 和 Docker Compose

## 目标项目目录

```text
project/personal_blog/
├── config/                 # Django 配置、路由、ASGI/WSGI
├── blog/                   # 文章、分类、标签
├── comments/               # 评论与审核
├── pages/                  # 关于我等静态页面
├── templates/              # Django 页面模板
├── static/                 # CSS、JavaScript、图片
├── media/                  # 开发环境上传文件
├── manage.py
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
└── README.md
```

## 第一版范围

- 管理员发布、编辑和删除文章
- Markdown、代码高亮、分类、标签和搜索
- 访客评论，评论经管理员审核后显示
- Django Admin 后台
- 关于我页面和云服务器部署准备

第一版不实现用户注册、多作者、点赞收藏、前后端分离、Elasticsearch、Redis 或 CI/CD。

## 工程约束

- 修改前先读取 `project/doc/blog_project_plan.md`，不得把规划外功能默认加入第一版。
- Django 应用职责分离：`blog`、`comments`、`pages` 不相互混放业务模型。
- 配置和密钥通过环境变量管理，不提交真实凭据。
- 新功能必须包含与风险相称的测试，并保持 README 与部署文档同步。
