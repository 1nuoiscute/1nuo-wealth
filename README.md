# 1nuo-wealth

[![Live Demo](https://img.shields.io/badge/Live%20Demo-在线演示-blue?style=for-the-badge&logo=googlechrome&logoColor=white)](https://wealth.1nuo.me/)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](https://github.com/1nuoiscute/1nuo-wealth/blob/main/LICENSE)

一个基于 **Cloudflare Workers + D1** 的 Serverless 私人财富管理中枢。集成 **DeepSeek (V3/R1)** 自然语言记账与新浪财经实盘接口，专为追求数据绝对隐私、零广告干扰及多账户独立管理的用户打造。

<p align="center">
<img src="https://img.1nuo.me/blog/2026/02/25/242b0d0c21a772f08399759f7d6e3932.webp" width="33%" />
<img src="https://img.1nuo.me/blog/2026/02/25/dd76d4d9d8e1decf2fc00b50c811b9f1.webp" width="33%" />
<img src="https://img.1nuo.me/blog/2026/02/25/284331e2ae3aa1d8c237df5cc1d011f2.webp" width="33%" />
</p>

## 💡 为什么做这个？

市面上的记账 App 充斥着理财广告与开屏弹窗，且往往存在数据隐私泄露的风险。更痛点的是，它们很难将“日常流水账”与“基金理财动态市值”进行有机的结合。

本项目旨在打造一个**完全属于自己的财务控制台**。通过 AI 语义理解彻底解放双手，结合无服务器架构（Serverless），将日常开销与投资动态融合在同一个大盘里，让你在网页（或 PWA 应用）里即可随时洞悉真实的“动态净资产”。

## 🌐 在线体验 (Live Demo)

如果你对本项目感兴趣，不想自己动手部署，欢迎直接访问我的站点进行体验：

👉 **[点击这里立即体验 1nuo-wealth](https://wealth.1nuo.me/)**

*(💡 隐私说明：系统底层已开启严格的 `user_id` 多用户数据物理隔离，你可以放心注册账号并体验完整功能，你的财务数据仅你个人可见，互不干扰。)*

## 🛠️ 核心功能

### 🤖 智能记账端 (AI Accounting)
* **极速自然语言录入**：只需输入“午餐肯德基50元微信付”，AI 即可精准提取金额、分类、账户及收支类型并自动入库。
* **账单语义修正**：支持全量语义覆盖，对已有账单输入“其实是支付宝付了30元”，即可调用 AI 自动分析并覆盖修正。
* **余额宝智能联动**：识别到余额宝收益或开销时，系统会自动同步修正底层基金本金池，确保账面资产与实际持仓对齐。

### 📈 投资雷达端 (Investment Radar)
* **实盘净值计算**：直连新浪财经 API，实时抓取货币/偏股基金净值，动态计算单只基金的“今日盈亏”与“累计收益率”。
* **对话式调仓助手**：在可视化弹窗中输入调仓指令（如“今天加仓1000元”），AI 自动换算当前净值与增减份额，并生成调仓流水。
* **防呆撤销机制**：所有的基金买卖操作均记录在独立的 `fund_logs` 流水中，支持一键撤销并回退份额。

### 💳 资产与系统管理 (System Management)
* **物理级多用户隔离**：底层基于 `user_id` 构筑隔离护城河，同一套部署环境支持家庭多成员独立注册、登录与使用。
* **AI Reasoner 财务审计**：一键调取当月全量流水与资产切片，交由 **DeepSeek-R1** 深度思考模型，输出具备逻辑深度的 Markdown 财务健康报告。
* **PWA 沉浸式应用**：完美适配移动端。通过浏览器“添加到主屏幕”，即可生成独立桌面图标，享受无地址栏的全屏原生 App 体验。

## 📐 动态资产模型

系统摒弃了传统的静态记账法，采用实时对冲算法生成你的**动态净资产总额**，确保财务大盘的严谨性与实时性：

$$Final\ Wealth=\sum(Liquid\ Assets)+\sum(Fund\ Shares\times NAV)-\sum(Liabilities)$$

* **流动资产 ($Liquid\ Assets$)**：微信、支付宝、银行卡等静态余额。
* **投资市值 ($Fund\ Shares\times NAV$)**：基于实时净值与持仓份额动态计算的基金池市值。
* **负债账单 ($Liabilities$)**：花呗、信用卡等待还负债。

*(注：针对净值永远为 1.0 的货币基金，系统内置了专属的【调平】机制，手动输入最新总额即可自动补齐累计利息差额。)*

## 📂 演进日志 (Evolution History)

好的架构是生长出来的。本仓库 `beta-versions` 目录下归档了系统的完整迭代源码，记录了项目的进化过程：

* 🐣 **v0.9 (原型破壳)**：跑通底层闭环。实现 DeepSeek 语义记账精准入库，构建账户标准化清洗逻辑，并成功集成 R1 深度思考模型生成原生 Markdown 审计报告。
* 📡 **v1.0 - v1.3 (投资雷达进化)**：重构基金逻辑。从硬编码转向“总盘+流水”双表驱动结构，新增新浪财经实盘净值抓取、对话式动态调仓、防呆单笔撤销功能，并开放前端自定义增删基金与动态预算体系。
* 🧱 **v2.0 - v2.01 (架构大跃迁)**：跨入多用户时代。引入 `sessions` 鉴权与全局路由守卫，底层 SQL 全量重写，全面注入 `user_id` 构筑严密的数据物理隔离墙；补充账户自定义增删能力。
* 🚀 **v2.1+ (正式版)**：向原生 App 看齐。全面引入 PWA 沉浸式标准，重塑 UI 细节（全局优雅通知胶囊），并针对货币基金（如余额宝）完善了零资产唤醒与利息手动对齐闭环。

## 🚀 快速上手

1. **准备环境**：注册 Cloudflare 账号，开通 Workers 与 D1 数据库服务。
2. **初始化数据库**：在 D1 控制台执行 SQL 语句，建立 `users`, `accounts`, `bills`, `funds`, `fund_logs`, `sessions` 等核心表。
3. **注入环境变量**：在 Worker 的 `Settings -> Variables` 中，新增名为 `DEEPSEEK_API_KEY` 的变量并填入你的 Key。
4. **绑定域名**：在触发器中绑定你的自定义域名（如 `money.yourdomain.com`），即刻开启私人财富管理之旅。

## 📄 开源协议
基于 [MIT License](LICENSE) 开源。
