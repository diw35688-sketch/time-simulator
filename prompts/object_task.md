# 任务：为「时间模拟器」写一个 3D 时间物品

物品：**{{OBJECT}}**

你只负责「这个物品随时间变化」这一层。手势和法阵由宿主页面负责，它会通过下面的接口驱动你。

## 产出
- 单个完整 HTML 文件，只输出一个 ```html 代码块
- three.js 必须这样引入（本地绝对路径，版本 r160，不能换成 CDN，不能用 examples/addons 里的任何模块）：
```html
<script type="importmap">{ "imports": { "three": "/vendor/three/three.module.js" } }</script>
<script type="module"> import * as THREE from 'three'; /* ... */ </script>
```
- 不允许加载任何外部文件（图片、模型、字体、纹理）。所有几何、材质、纹理都用代码生成（LatheGeometry / 自定义 BufferGeometry / 顶点位移 / ShaderMaterial / CanvasTexture / 程序噪声）
- 不允许 fetch、XMLHttpRequest、WebSocket、localStorage、cookie。页面运行在沙箱里，唯一允许的对外通信是加载完成后执行一次 `window.parent.postMessage({ type: 'timespell:stages', stages: getStages() }, '*')`

## 3D 要求
- 必须是真正的三维模型：有体积、有光照、有明暗和高光，不能是贴在平面上的图片
- 透视相机，物品呈 3/4 侧视角，能看出立体感；三点布光（主光、补光、轮廓光）+ 环境光，适合放在暗色背景上
- 材质有质感（MeshStandardMaterial / MeshPhysicalMaterial 或自写着色器）
- 别忘了 `document.body.appendChild(renderer.domElement)`，canvas 铺满窗口（position: fixed; inset: 0）
- **性能**：拨动时间时 `setTime` 每秒会被调用 60 次。所有几何体、材质、纹理都在开头一次建好，`setTime` 里只改 uniform、顶点位置、变换、颜色和可见性，不要在 `setTime` 里 new 几何体、材质或纹理（会卡顿、内存越用越多）。需要粒子（雪花、落叶、蒸汽、火花）就预先建好固定数量，用 t 算位置和透明度

## 时间定义（核心）
`t ∈ [-1, 1]`，连续可来回拨：
- `t = 0`：现在，物品最典型、最完好的样子
- `t → -1`：过去，倒推它的来历（由你设计 3–4 个阶段）
- `t → +1`：未来，它的消耗、衰败或终局（由你设计 3–4 个阶段）
- 阶段之间必须连续过渡（形变、颜色、粒子都随 t 平滑变化），不能硬切

**硬性要求：画面必须是 t 的纯函数。** 不许依赖累积状态，不许用 Math.random / Date / performance.now 影响画面。需要随机就用固定种子的伪随机数。同一个 t 每次渲染的画面必须逐像素一致，这样往回拨才能精确复原。物品的旋转角度也只能由 t 决定（例如 yaw = 0.6 + 0.4 * t），不要自动旋转。

## 接口（必须实现，且在页面脚本一开始就定义好，不要等资源加载）
```js
window.setTime(t)            // 外部设置时间，自动截断到 [-1, 1]，并立即重新渲染
window.getTime()             // 返回当前 t
window.getStages()           // 返回阶段列表 [{ t: -1, name: '…' }, …, { t: 0, name: '…' }, …, { t: 1, name: '…' }]
window.addEventListener('message', e => { if (e.data?.type === 'timespell:setTime') setTime(e.data.t) })
window.__timeState = () => ({ t, fps })
```

## 两种模式
- 默认（独立模式）：深色背景，底部一个滑块（-1 到 1，步长 0.001），滑块上方显示当前阶段名；键盘 ← → 微调
- `?embed=1`（嵌入模式）：`new THREE.WebGLRenderer({ alpha: true })` 且 `setClearColor(0x000000, 0)`，`html` 和 `body` 的 CSS 背景也都要设成 transparent（只设画布透明不够），整页完全透明，不显示任何 UI。物品中心位于画面 (50%, 60%)，物品在屏幕上的最大尺寸约为 `min(宽, 高) × 0.35`。所有 t 下，物品连同火焰、烟、蒸汽、花瓣、落叶、雪花这些附属部分，都要落在以 (50%, 60%) 为中心、边长 `min(宽, 高) × 0.5` 的方框里。窗口缩放时自适应

## 验收标准（会自动逐条检查）
1. 控制台没有任何报错
2. 集成显卡上帧率 ≥ 30
3. 依次 `setTime(0.7)`、`setTime(-0.5)`、`setTime(0.7)`，第一次和第三次的画面逐像素相同
4. 嵌入模式背景透明（四角像素 alpha = 0）、没有 UI，物品落在约定的位置和大小内
5. 物品在 t = -1、0、+1 三个时刻的外观明显不同
6. 没有任何外部资源请求，没有文字水印或品牌元素
7. 连续 120 帧每帧调用一次 `setTime`（来回扫动），平均每帧耗时 ≤ 20ms，内存不持续增长

只输出一个 ```html 代码块，然后用一句话列出你设计的过去和未来各阶段。
