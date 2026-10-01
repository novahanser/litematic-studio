# 初始开源项目调研

本记录说明 Litematic Studio 初次实现时的选型依据。调研日期为 2026-10-02（Australia/Adelaide），结论限于下列提交或当时查看的 README，不代表其他项目最新版本的能力。1.1.0 新增的编辑和实体预览见 [更新记录](../CHANGELOG.md)。

初始需求包括独立 Windows 程序、从本地游戏 JAR 读取模型与贴图、单层及多层筛选、按方块类型控制显隐、3D 点选 NBT、区分容器空/有物品/未知，以及材料导出。

## 已检查的项目

### albertchen857 / Litematica-viewer

[仓库](https://github.com/albertchen857/Litematica-viewer)；检查提交 [`65f4174`](https://github.com/albertchen857/Litematica-viewer/tree/65f41744eb372c8ffa40e23462fd13cb6168133f)，仓库声明 [MIT](https://github.com/albertchen857/Litematica-viewer/blob/65f41744eb372c8ffa40e23462fd13cb6168133f/LICENSE)。

这是较接近初始需求的桌面方案，提供结构读取、材料和容器分析、逐层观察、独立 3D 窗口及 [EXE 打包定义](https://github.com/albertchen857/Litematica-viewer/blob/65f41744eb372c8ffa40e23462fd13cb6168133f/LitematicaViewer.spec)。

所检查的 [3D 数据桥接](https://github.com/albertchen857/Litematica-viewer/blob/65f41744eb372c8ffa40e23462fd13cb6168133f/script/lv/render.py) 没有传入逐方块 NBT 与库存；[筛选代码](https://github.com/albertchen857/Litematica-viewer/blob/65f41744eb372c8ffa40e23462fd13cb6168133f/script/JSrender/src/bridge.js) 使用 Y 层和内置图集；[查看器交互](https://github.com/albertchen857/Litematica-viewer/blob/65f41744eb372c8ffa40e23462fd13cb6168133f/script/JSrender/src/viewer.js) 中未找到点选方块与 NBT 关联的实现。满足本项目的资源读取和检查流程需要改造多个模块。

### LGRY-chan / SchemViewer

[仓库](https://github.com/LGRY-chan/SchemViewer)；检查提交 [`bc0928e`](https://github.com/LGRY-chan/SchemViewer/tree/bc0928e9c34ceabfd5bcd8dec6d056528062771a)，许可为 [MIT](https://github.com/LGRY-chan/SchemViewer/blob/bc0928e9c34ceabfd5bcd8dec6d056528062771a/LICENSE)。

[该版本 README](https://github.com/LGRY-chan/SchemViewer/blob/bc0928e9c34ceabfd5bcd8dec6d056528062771a/README.md) 描述浏览器内离线解析、Deepslate 渲染、Y 轴切片、子区域显隐、材料及 CSV/JSON 导出。所检查的 [材料复选框](https://github.com/LGRY-chan/SchemViewer/blob/bc0928e9c34ceabfd5bcd8dec6d056528062771a/js/controller.js) 用于收集进度；[渲染器](https://github.com/LGRY-chan/SchemViewer/blob/bc0928e9c34ceabfd5bcd8dec6d056528062771a/js/renderer-3d.js) 使用预制图集。该资源流程与从用户选定的客户端 JAR 动态读取模型不同。

所检查的 [解析器](https://github.com/LGRY-chan/SchemViewer/blob/bc0928e9c34ceabfd5bcd8dec6d056528062771a/js/parser.js) 提取布局、状态和普通实体；未找到把 `TileEntities` 库存关联到逐方块检查的完整流程。封装为桌面程序之外，仍需增加本项目需要的资源与库存功能。

### Jopgood / minecraft-schematic-viewer

[仓库与 README](https://github.com/Jopgood/minecraft-schematic-viewer)。检查范围仅为当日 README，没有完整运行或代码审计；其 MIT 许可说明也仅核查到 README。

当时 README 描述 Three.js / WebGL 预览、多种格式、分层和实例化渲染，同时列出部分新版方块、楼梯台阶和红石形状的显示限制。这些涉及本项目希望检查的技术结构，因此没有将其作为可直接交付的方案。该判断仅针对当时的说明。

## 实现选择

最终使用 Electron、Three.js 和 adm-zip 独立实现桌面界面、NBT/Litematic 读写、本地资源读取、筛选、点选与材料统计，没有复制或改名包装上述查看器的源代码，也没有使用其内置游戏图集。

格式兼容性另外参考 [Litematica 维护分支源码](https://github.com/sakura-ryoko/litematica/blob/1.21.11/src/main/java/fi/dy/masa/litematica/schematic/LitematicaSchematic.java)，核对位打包、负尺寸区域与坐标规则。这属于格式核对，没有嵌入其游戏内渲染代码。

依赖版本与许可见 [`package-lock.json`](../package-lock.json) 和 [第三方声明](../THIRD_PARTY_NOTICES.txt)。Minecraft 客户端、资源包与私人验证文件由使用者自行提供，不随源码或便携包分发。此记录是选型说明，不是 GUI 或 EXE 验收报告。
