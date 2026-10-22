# 初始项目选型

以下为 2026-10-02 的历史检查，不代表这些项目当前能力。

| 项目 / 检查版本 | 与初始需求的差异 |
| --- | --- |
| [albertchen857/Litematica-viewer · 65f4174](https://github.com/albertchen857/Litematica-viewer/tree/65f41744eb372c8ffa40e23462fd13cb6168133f) | 有桌面、分层、材料及容器分析；检查的 3D 数据桥未关联逐方块 NBT，渲染使用内置图集。 |
| [LGRY-chan/SchemViewer · bc0928e](https://github.com/LGRY-chan/SchemViewer/tree/bc0928e9c34ceabfd5bcd8dec6d056528062771a) | 有浏览器预览和材料导出；使用预制图集，未找到逐方块库存检查的完整流程。 |
| [Jopgood/minecraft-schematic-viewer](https://github.com/Jopgood/minecraft-schematic-viewer) | 仅检查当日 README；其列出的新版和非完整方块限制涉及本项目主要用途。 |

因此使用 Electron、Three.js 和 adm-zip 独立实现本地资源读取、解析、点选和界面，未复制上述查看器代码或图集。格式规则参考 [Litematica 维护分支](https://github.com/sakura-ryoko/litematica/blob/1.21.11/src/main/java/fi/dy/masa/litematica/schematic/LitematicaSchematic.java)，核对位打包、负尺寸与坐标。

依赖许可见 [第三方声明](../THIRD_PARTY_NOTICES.txt)。游戏资源由用户自行提供。