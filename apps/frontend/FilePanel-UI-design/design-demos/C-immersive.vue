<template>
  <div class="design-demo-container">
    <div class="gradient-bg">
      <div class="orb orb-1"></div>
      <div class="orb orb-2"></div>
      <div class="orb orb-3"></div>
      <div class="orb orb-4"></div>
      <div class="orb orb-5"></div>
    </div>
    
    <div class="panel-wrapper">
      <aside class="file-panel glass-panel">
        <div class="toolbar">
          <select class="root-selector glass-control">
            <option value="workspace">Workspace</option>
            <option value="home">Home</option>
          </select>
          <button class="glass-chip">
            <span class="icon">↑</span>
            <span>上传</span>
          </button>
          <button class="glass-chip">
            <span class="icon">♲</span>
            <span>回收站</span>
          </button>
          <button class="glass-icon-btn">×</button>
        </div>

        <div class="search-bar">
          <div class="search-mode-toggle glass-control">
            <button class="mode-btn active" data-mode="name">名称</button>
            <button class="mode-btn" data-mode="content">内容</button>
          </div>
          <div class="search-row">
            <input type="text" class="search-input glass-control" placeholder="搜索文件名..." value="config" />
            <button class="glass-icon-btn">⌂</button>
            <button class="glass-icon-btn">×</button>
            <select class="sort-select glass-control">
              <option value="name">名称</option>
              <option value="size">大小</option>
              <option value="modified">修改</option>
            </select>
            <button class="glass-icon-btn sort-dir">↑</button>
          </div>
        </div>

        <div class="filter-bar">
          <div class="filter-toggle glass-control">
            <button class="filter-btn active" data-filter="all">全部</button>
            <button class="filter-btn" data-filter="file">文件</button>
            <button class="filter-btn" data-filter="directory">目录</button>
          </div>
          <button class="glass-chip dotfiles-toggle active">
            <span class="toggle-indicator"></span>
            隐藏文件
          </button>
        </div>

        <div class="file-list">
          <div class="tree-node" data-selected="true">
            <button class="expand-btn">▾</button>
            <span class="file-icon folder">▣</span>
            <span class="file-name">src</span>
            <span class="file-meta"></span>
          </div>
          
          <div class="tree-children">
            <div class="tree-node" data-selected="false">
              <button class="expand-btn">▾</button>
              <span class="file-icon folder">▣</span>
              <span class="file-name">components</span>
            </div>
            
            <div class="tree-children">
              <div class="tree-node">
                <button class="expand-btn"></button>
                <span class="file-icon image">▧</span>
                <span class="file-name">logo.png</span>
                <span class="file-meta">2.4KB</span>
              </div>
              <div class="tree-node">
                <button class="expand-btn"></button>
                <span class="file-icon code">&lt;&gt;</span>
                <span class="file-name">Header.tsx</span>
                <span class="file-meta">4.2KB</span>
              </div>
              <div class="tree-node selected">
                <button class="expand-btn"></button>
                <span class="file-icon config">&lt;/&gt;</span>
                <span class="file-name">config.json</span>
                <span class="file-meta selected-badge">选中</span>
              </div>
              <div class="tree-node">
                <button class="expand-btn"></button>
                <span class="file-icon markdown">M</span>
                <span class="file-name">README.md</span>
                <span class="file-meta">12KB</span>
              </div>
            </div>

            <div class="tree-node">
              <button class="expand-btn">▸</button>
              <span class="file-icon folder">▣</span>
              <span class="file-name">utils</span>
            </div>

            <div class="tree-node">
              <button class="expand-btn"></button>
              <span class="file-icon code">&lt;&gt;</span>
              <span class="file-name">index.ts</span>
              <span class="file-meta">8.6KB</span>
            </div>
            <div class="tree-node">
              <button class="expand-btn"></button>
              <span class="file-icon code">&lt;&gt;</span>
              <span class="file-name">App.tsx</span>
              <span class="file-meta">2.1KB</span>
            </div>
          </div>

          <div class="tree-node">
            <button class="expand-btn">▸</button>
            <span class="file-icon folder">▣</span>
            <span class="file-name">node_modules</span>
          </div>
          <div class="tree-node">
            <button class="expand-btn"></button>
            <span class="file-icon default">□</span>
            <span class="file-name">package.json</span>
            <span class="file-meta">1.8KB</span>
          </div>
          <div class="tree-node">
            <button class="expand-btn"></button>
            <span class="file-icon default">□</span>
            <span class="file-name">tsconfig.json</span>
            <span class="file-meta">0.8KB</span>
          </div>
          <div class="tree-node">
            <button class="expand-btn"></button>
            <span class="file-icon default">□</span>
            <span class="file-name">.gitignore</span>
            <span class="file-meta dotfile">隐藏</span>
          </div>
        </div>

        <div class="context-menu glass-menu" id="contextMenu">
          <button class="menu-item">
            <span class="menu-icon">📂</span>
            <span>打开</span>
          </button>
          <button class="menu-item">
            <span class="menu-icon">↵</span>
            <span>插入路径</span>
          </button>
          <div class="menu-divider"></div>
          <button class="menu-item">
            <span class="menu-icon">⎘</span>
            <span>复制名称</span>
          </button>
          <button class="menu-item">
            <span class="menu-icon">⊞</span>
            <span>复制路径</span>
          </button>
          <div class="menu-divider"></div>
          <button class="menu-item">
            <span class="menu-icon">📋</span>
            <span>复制</span>
          </button>
          <button class="menu-item">
            <span class="menu-icon">✂</span>
            <span>移动</span>
          </button>
          <button class="menu-item">
            <span class="menu-icon">✏</span>
            <span>重命名</span>
          </button>
          <div class="menu-divider"></div>
          <button class="menu-item danger">
            <span class="menu-icon">🗑</span>
            <span>删除</span>
          </button>
        </div>
      </aside>
    </div>

    <div class="demo-title">
      <span class="demo-badge">iOS 27</span>
      <h1>沉浸型毛玻璃设计</h1>
      <p>方向 C: visionOS 液态玻璃风格</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

const showContextMenu = ref(false)

onMounted(() => {
  const fileNodes = document.querySelectorAll('.tree-node[data-selected="true"]')
  fileNodes.forEach(node => {
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const menu = document.getElementById('contextMenu')
      if (menu) {
        menu.style.display = 'block'
        menu.style.left = `${(e as MouseEvent).clientX}px`
        menu.style.top = `${(e as MouseEvent).clientY}px`
        showContextMenu.value = true
      }
    })
  })

  document.addEventListener('click', () => {
    const menu = document.getElementById('contextMenu')
    if (menu) {
      menu.style.display = 'none'
      showContextMenu.value = false
    }
  })

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
    })
  })

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
    })
  })

  document.querySelector('.dotfiles-toggle')?.addEventListener('click', function(this: Element) {
    this.classList.toggle('active')
  })

  document.querySelectorAll('.tree-node').forEach(node => {
    node.addEventListener('click', () => {
      document.querySelectorAll('.tree-node').forEach(n => n.classList.remove('selected'))
      node.classList.add('selected')
    })
  })
})
</script>

<style scoped>
.design-demo-container {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
}

.gradient-bg {
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, #0a0a0f 0%, #0d0d15 100%);
  overflow: hidden;
}

.orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(80px);
  opacity: 0.6;
  animation: float 20s ease-in-out infinite;
}

.orb-1 {
  width: 600px;
  height: 600px;
  background: radial-gradient(circle, rgba(124, 58, 237, 0.8) 0%, rgba(124, 58, 237, 0) 70%);
  top: -200px;
  left: -100px;
  animation-delay: 0s;
}

.orb-2 {
  width: 500px;
  height: 500px;
  background: radial-gradient(circle, rgba(6, 182, 212, 0.7) 0%, rgba(6, 182, 212, 0) 70%);
  top: 20%;
  right: -150px;
  animation-delay: -5s;
}

.orb-3 {
  width: 550px;
  height: 550px;
  background: radial-gradient(circle, rgba(236, 72, 153, 0.75) 0%, rgba(236, 72, 153, 0) 70%);
  bottom: -200px;
  left: 20%;
  animation-delay: -10s;
}

.orb-4 {
  width: 400px;
  height: 400px;
  background: radial-gradient(circle, rgba(34, 211, 238, 0.6) 0%, rgba(34, 211, 238, 0) 70%);
  top: 50%;
  left: 50%;
  animation-delay: -15s;
}

.orb-5 {
  width: 450px;
  height: 450px;
  background: radial-gradient(circle, rgba(168, 85, 247, 0.65) 0%, rgba(168, 85, 247, 0) 70%);
  top: 70%;
  right: 10%;
  animation-delay: -8s;
}

@keyframes float {
  0%, 100% { transform: translate(0, 0) scale(1); }
  25% { transform: translate(30px, -40px) scale(1.05); }
  50% { transform: translate(-20px, 20px) scale(0.95); }
  75% { transform: translate(40px, 30px) scale(1.02); }
}

.panel-wrapper {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 380px;
  max-height: 85vh;
}

.file-panel {
  width: 100%;
  max-height: 85vh;
  border-radius: 24px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.glass-panel {
  background: rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(28px) saturate(200%);
  -webkit-backdrop-filter: blur(28px) saturate(200%);
  border: 1px solid rgba(255, 255, 255, 0.25);
  box-shadow: 
    inset 0 1px 0 rgba(255, 255, 255, 0.4),
    inset 0 -1px 0 rgba(0, 0, 0, 0.1),
    0 25px 80px rgba(0, 0, 0, 0.5),
    0 0 60px rgba(124, 58, 237, 0.15),
    0 0 80px rgba(6, 182, 212, 0.1);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.root-selector {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 12px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.9);
  font-size: 12px;
  cursor: pointer;
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}

.glass-control {
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  transition: all 0.2s ease;
}

.glass-control:focus,
.glass-control:hover {
  border-color: rgba(6, 182, 212, 0.5);
  background: rgba(255, 255, 255, 0.12);
}

.glass-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.85);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}

.glass-chip:hover {
  background: rgba(255, 255, 255, 0.18);
  border-color: rgba(255, 255, 255, 0.3);
  transform: scale(1.02);
}

.glass-chip:active {
  transform: scale(0.96);
}

.glass-chip .icon {
  font-size: 12px;
}

.glass-icon-btn {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.7);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s ease;
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}

.glass-icon-btn:hover {
  background: rgba(255, 255, 255, 0.14);
  border-color: rgba(255, 255, 255, 0.25);
  color: rgba(255, 255, 255, 0.95);
}

.search-bar {
  padding: 12px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.search-mode-toggle {
  display: flex;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(0, 0, 0, 0.2);
  padding: 3px;
  margin-bottom: 10px;
}

.mode-btn {
  flex: 1;
  padding: 6px 12px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: rgba(255, 255, 255, 0.6);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.mode-btn.active {
  background: rgba(6, 182, 212, 0.3);
  color: rgba(255, 255, 255, 0.95);
  box-shadow: 0 2px 8px rgba(6, 182, 212, 0.3);
}

.search-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.search-input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 12px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(0, 0, 0, 0.2);
  color: rgba(255, 255, 255, 0.9);
  font-size: 12px;
  font-family: monospace;
}

.search-input::placeholder {
  color: rgba(255, 255, 255, 0.4);
}

.sort-select {
  height: 32px;
  padding: 0 8px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(0, 0, 0, 0.2);
  color: rgba(255, 255, 255, 0.8);
  font-size: 11px;
  cursor: pointer;
}

.sort-dir {
  font-size: 16px;
  font-weight: bold;
}

.filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.filter-toggle {
  display: flex;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(0, 0, 0, 0.15);
  padding: 2px;
}

.filter-btn {
  padding: 5px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: rgba(255, 255, 255, 0.55);
  font-size: 10px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.filter-btn.active {
  background: rgba(168, 85, 247, 0.35);
  color: rgba(255, 255, 255, 0.95);
}

.dotfiles-toggle {
  padding: 5px 10px;
  font-size: 10px;
}

.dotfiles-toggle .toggle-indicator {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.3);
  transition: all 0.2s ease;
}

.dotfiles-toggle.active .toggle-indicator {
  background: rgba(6, 182, 212, 0.9);
  box-shadow: 0 0 8px rgba(6, 182, 212, 0.6);
}

.file-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
  min-height: 300px;
  max-height: 50vh;
}

.file-list::-webkit-scrollbar {
  width: 8px;
}

.file-list::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 4px;
}

.file-list::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, rgba(124, 58, 237, 0.6), rgba(6, 182, 212, 0.5));
  border-radius: 4px;
}

.tree-node {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s ease;
  color: rgba(255, 255, 255, 0.75);
  font-size: 12px;
}

.tree-node:hover {
  background: rgba(255, 255, 255, 0.08);
}

.tree-node.selected {
  background: rgba(6, 182, 212, 0.2);
  border: 1px solid rgba(6, 182, 212, 0.3);
  color: rgba(255, 255, 255, 0.95);
}

.expand-btn {
  width: 14px;
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.5);
  font-size: 8px;
  cursor: pointer;
  flex-shrink: 0;
}

.expand-btn:hover {
  color: rgba(255, 255, 255, 0.9);
}

.file-icon {
  font-size: 10px;
  width: 14px;
  text-align: center;
  flex-shrink: 0;
}

.file-icon.folder {
  color: #dcb67a;
}

.file-icon.image {
  color: #61c7ff;
}

.file-icon.code {
  color: #c2d1ff;
}

.file-icon.markdown {
  color: #79d2a6;
}

.file-icon.config {
  color: #e8c46a;
}

.file-icon.default {
  color: rgba(255, 255, 255, 0.5);
}

.file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: monospace;
  font-size: 11px;
}

.file-meta {
  font-size: 9px;
  color: rgba(255, 255, 255, 0.4);
  flex-shrink: 0;
}

.file-meta.selected-badge {
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(6, 182, 212, 0.25);
  color: #22d3ee;
}

.file-meta.dotfile {
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(168, 85, 247, 0.2);
  color: rgba(168, 85, 247, 0.9);
}

.tree-children {
  padding-left: 20px;
}

.glass-menu {
  position: fixed;
  width: 180px;
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(20, 20, 30, 0.85);
  backdrop-filter: blur(30px) saturate(180%);
  -webkit-backdrop-filter: blur(30px) saturate(180%);
  box-shadow: 
    inset 0 1px 0 rgba(255, 255, 255, 0.3),
    0 20px 60px rgba(0, 0, 0, 0.5),
    0 0 40px rgba(124, 58, 237, 0.2);
  padding: 6px;
  display: none;
  z-index: 1000;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: rgba(255, 255, 255, 0.8);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s ease;
}

.menu-item:hover {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.95);
}

.menu-item.danger {
  color: rgba(248, 113, 113, 0.9);
}

.menu-item.danger:hover {
  background: rgba(248, 113, 113, 0.15);
  color: rgb(248, 113, 113);
}

.menu-icon {
  font-size: 14px;
  width: 18px;
  text-align: center;
}

.menu-divider {
  height: 1px;
  background: rgba(255, 255, 255, 0.1);
  margin: 4px 8px;
}

.demo-title {
  position: absolute;
  bottom: 40px;
  left: 50%;
  transform: translateX(-50%);
  text-align: center;
  color: rgba(255, 255, 255, 0.9);
}

.demo-badge {
  display: inline-block;
  padding: 4px 12px;
  border-radius: 999px;
  background: linear-gradient(135deg, rgba(124, 58, 237, 0.6), rgba(6, 182, 212, 0.6));
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  margin-bottom: 12px;
}

.demo-title h1 {
  font-size: 24px;
  font-weight: 600;
  margin-bottom: 6px;
  background: linear-gradient(135deg, #fff 0%, rgba(255, 255, 255, 0.7) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.demo-title p {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.5);
}
</style>
