# 1.3.0 方块审计记录

历史环境：Litematic Studio 1.3.0 / Minecraft Java 1.21.11 原版客户端。通过表示未发现下列检查异常，不代表与游戏逐像素一致。

| 检查 | 结果 |
| --- | --- |
| 官方注册表 | 1,166 种方块 / 29,671 个合法状态 |
| CPU 资源与几何 | 全部状态进入检查，无缺失模型、材质或非法几何问题 |
| GPU 四方向独立绘制 | 全部状态进入检查，无 WebGL 错误或意外空白 |
| 水及含水专项 | 10,506 个状态通过；62 个无外露水面的状态均为双台阶 |
| 核心测试 | 启用本地可选输入后 148 通过，0 失败 / 跳过 |

CPU 分类：26,740 个通过、2,826 个静态近似、93 个合法空模型、**12 个移动活塞未验收运动外观**。移动活塞需要额外运动 NBT，不能将暂不显示动态部分算作显示正确。

资源检查覆盖所有加权模型候选；实际预览和 GPU 检查采用第一候选。四方向检查验证可见像素和 WebGL 状态，另查看了 15 张类型对照图；它不证明每个 UV、全部角度或 NBT 外观一致。箱子、头颅等特殊模型另核对了本地原版几何和材质规则。

范围不包括完整动态效果、告示牌文字、旗帜 / 陶罐图案、自定义头颅皮肤、流体模拟或全部资源包扩展。结果不能直接推广到其他游戏版本或模组。

## 复现

需要对应版本的本地 Java 和游戏依赖；生成注册表不会启动游戏或修改游戏目录。

```powershell
npm ci
$env:MINECRAFT_JAR = "本地客户端.jar"
node scripts/audit-blocks.cjs --jar $env:MINECRAFT_JAR --generate-registry

$env:BLOCK_REGISTRY = "test-results/block-audit/vanilla-registry/reports/blocks.json"
$env:BLOCK_AUDIT_MANIFEST = "test-results/block-audit/manifest.json"
$env:MINECRAFT_REGISTRY = $env:BLOCK_REGISTRY
$env:MINECRAFT_BLOCK_REGISTRY = $env:BLOCK_REGISTRY
npm test
npm run build
node tests/nonfull-gpu-smoke.cjs
```

已有注册表时，用 `--registry <reports/blocks.json>` 替代 `--generate-registry`。未提供注册表时只能推导资源中的可视属性，不能声称完整合法状态覆盖。完整 GPU 检查不可设置缩小范围的 `BLOCK_GPU_FILTER`。

历史核心测试另启用 `LITEMATIC_SAMPLE`、`COPPER_MODEL_ORACLE`、`SPECIAL_MODEL_ORACLE`。缺少这些输入时相关测试跳过，计数会不同。报告、截图和原版对照文件仅存于本地 `test-results/`，不分发游戏资产或私人投影。