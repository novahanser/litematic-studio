# Litematic Studio

独立的 Windows x64 `.litematic` 查看与编辑工具。无需启动 Minecraft，模型、贴图、物品图标与容器界面直接读取本地游戏资源。

**[下载便携 EXE](https://github.com/novahanser/litematic-studio/releases/latest)** · [更新记录](CHANGELOG.md)

## 开始使用

1. 下载并运行 `Litematic-Studio-1.4.0-win-x64.exe`，无需安装 Java、Python 或 Node.js。
2. 点击「打开投影」、按 `Ctrl+O`，或拖入 `.litematic`。
3. 在「材质」选择完整 Minecraft 客户端 JAR；可再叠加一个资源包 ZIP。Litematica 模组 JAR 不含完整游戏材质。
4. 用窗口右上角语言选择切换简体中文 / English；程序会记住设置。

**English:** Download the portable EXE, select **English**, open a `.litematic`, then select your local Minecraft client JAR under **Resources**. No game launch or additional runtime is needed.

## 主要功能

- 全部、单层、范围或不连续多层显示；方块种类、含水、通电等状态与 NBT 条件筛选。
- 本地模型、朝向、透明面与含水空隙预览；点选方块查看坐标、状态和完整 NBT。
- 容器按对应槽位显示：单箱 / 双箱、潜影盒、木桶、漏斗、投掷器、熔炉、酿造台与合成器等；物品显示本地图标、数量与详情。
- 实体清单、静态预览、定位和 NBT 导出。
- 批量替换方块，支持当前可见部分或整个投影、撤销 / 重做和另存。
- 整体或可见部分材料统计，以及 CSV、NBT JSON、PNG 导出。

## 视图操作

| 操作 | 方法 |
| --- | --- |
| 旋转 / 平移 | 中键拖动 / `Shift` + 中键 |
| 朝鼠标位置缩放 | 滚轮；支持透视、正交与表面深度跟随 |
| 拖动缩放 | `Ctrl` + 中键 |
| 选择 | 左键单击 |
| 前 / 右 / 顶视 | 小键盘 `1` / `3` / `7`；加 `Ctrl` 查看反方向 |
| 透视 / 正交 | 小键盘 `5` |
| 聚焦 / 适应结构 | 小键盘 `.` / `Home` 或 `F` |
| 打开 / 另存 | `Ctrl+O` / `Ctrl+S` |
| 撤销 / 重做 | `Ctrl+Z` / `Ctrl+Y` 或 `Ctrl+Shift+Z` |

高度、种类和状态条件共同生效。多层输入例如 `0, 3, 6-10`。搜索只缩小列表，实际显隐由勾选状态决定。实体跟随高度筛选，可在实体页单独隐藏。

## 容器与编辑

容器读取保存投影时的库存：明确记录无物品时显示为空；缺少 NBT 或库存字段时显示未知；战利品表单独标注。双箱只合并同一区域内位置、类型、朝向匹配的两半。末影箱的玩家库存不在方块 NBT 中，无法从投影获取。未识别的自定义库存仍可检查原始 NBT。

槽位图使用对应容器的布局，不虚构玩家背包。点击物品可查看槽位、数量与原始数据。它是库存检查器，不模拟配方、燃烧、酿造或物品移动。

替换先在内存中进行，另存后才写出文件。同类型及已识别兼容家族可保留方块实体 NBT；不兼容替换会移除原库存等 NBT，面板会提示影响。若要强制目标属性，请取消「保留兼容的源状态」。替换不运行邻居更新，不自动修正流体、红石或多格结构连接。

材料按物品合并，双台阶计两个，门与床按代表部分计件。容器和实体内的物品不计入建材；额外含水、盆栽物品与施工耗材不在估算中。

## 显示范围

面向 Java 版 `.litematic`，开发验证使用 1.21.11 原版资源。特殊方块与实体采用静态模型；不完整复现动画、告示牌文字、旗帜 / 陶罐图案、自定义皮肤、附魔效果及资源包渲染扩展。移动活塞的运动部分尚未还原。水、环境色与光照是预览，不模拟完整游戏行为。资源缺失或近似说明见「材质」。

资源包的自定义物品模型和复杂组件外观可能无法完全复现；不能生成图标时保留物品名称、数量和 NBT。未知或缺失数据不会被当作空库存。

运行时不上传投影或下载材质。游戏 JAR、资源包和私人测试文件不随项目分发。

## 开发与验证

使用 Windows / Node.js 24：

```powershell
npm ci
npm test
npm run build
npm start
npm run dist
```

可选集成测试通过 `MINECRAFT_JAR` 和 `LITEMATIC_SAMPLE` 指定本地资源；未提供时相关测试明确跳过。桌面检查使用 `test:app`、`test:edit`、`test:renderer`、`test:display`、`test:materials`、`test:containers`、`test:language`、`test:cursor`；打包后运行 `test:portable`。测试产物位于 Git 忽略的 `test-results/`。

全量方块检查的方法、1.3.0 历史结果与覆盖边界见 [方块审计](docs/BLOCK-AUDIT-1.3.0.md)。CI 执行核心测试与构建，不代替桌面和 EXE 验收。

[MIT 许可](LICENSE) · [第三方声明](THIRD_PARTY_NOTICES.txt) · [初始项目选型](docs/OPEN-SOURCE-REVIEW.md)
