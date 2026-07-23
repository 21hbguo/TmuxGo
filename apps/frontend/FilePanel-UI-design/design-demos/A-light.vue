<template>
  <div class="demo-container">
    <svg width="0" height="0" style="position:absolute">
      <defs>
        <filter id="liquid-lens">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>
    </svg>
    <div class="glass-panel">
      <div class="toolbar">
        <div class="toolbar-row">
          <select class="glass-select">
            <option>Workspace</option>
            <option>Home</option>
          </select>
          <button class="glass-chip">↑ 上传</button>
          <button class="glass-chip">♲ 回收站</button>
        </div>
      </div>
      <div class="search-bar">
        <div class="search-toggle">
          <button :class="['toggle-btn', { active: searchMode === 'name' }]" @click="searchMode = 'name'">name</button>
          <button :class="['toggle-btn', { active: searchMode === 'content' }]" @click="searchMode = 'content'">content</button>
        </div>
        <div class="search-input-row">
          <input type="text" class="glass-input" placeholder="Search files..." v-model="searchQuery" />
          <button class="toolbar-icon">⌂</button>
          <button class="toolbar-icon" @click="searchQuery = ''">×</button>
          <select class="glass-select-sm">
            <option>name</option>
            <option>size</option>
            <option>modified</option>
          </select>
          <button class="toolbar-icon">↑</button>
        </div>
        <div class="filter-row">
          <div class="search-toggle">
            <button :class="['toggle-btn', { active: typeFilter === 'all' }]" @click="typeFilter = 'all'">all</button>
            <button :class="['toggle-btn', { active: typeFilter === 'file' }]" @click="typeFilter = 'file'">file</button>
            <button :class="['toggle-btn', { active: typeFilter === 'directory' }]" @click="typeFilter = 'directory'">directory</button>
          </div>
          <button :class="['toggle-btn', { active: !hideDotFiles }]" @click="hideDotFiles = !hideDotFiles">.dot</button>
        </div>
      </div>
      <div class="file-list" @contextmenu.prevent="showContextMenu">
        <div class="tree-node" v-for="item in visibleFiles" :key="item.path" :style="{ paddingLeft: (item.depth * 14 + 8) + 'px' }">
          <button v-if="item.type === 'directory'" class="expand-btn" @click="toggleExpand(item)">
            {{ expandedItems.has(item.path) ? '▾' : '▸' }}
          </button>
          <span v-else class="expand-placeholder"></span>
          <div
            class="file-item"
            :class="{ selected: selectedPath === item.path, directory: item.type === 'directory' }"
            @click="selectItem(item)"
            @dblclick="handleDoubleClick(item)"
            @contextmenu.prevent.stop="openContextMenu($event, item)"
          >
            <span class="file-icon" :class="item.type">{{ item.icon }}</span>
            <span class="file-name">{{ item.name }}</span>
            <span v-if="item.type === 'file'" class="file-size">{{ item.size }}</span>
            <span v-if="item.type === 'directory' && !expandedItems.has(item.path) && !hasChildren(item)" class="empty-dir">empty</span>
          </div>
        </div>
      </div>
      <div v-if="contextMenuVisible" class="context-menu" :style="{ left: contextMenuX + 'px', top: contextMenuY + 'px' }" @click.stop>
        <button v-if="contextMenuItem?.type === 'directory'" class="menu-item" @click="handleMenuAction('favorite')">
          <span class="menu-icon">★</span> 收藏
        </button>
        <button v-if="contextMenuItem?.type === 'file'" class="menu-item" @click="handleMenuAction('open')">
          <span class="menu-icon">⟐</span> 在编辑器打开
        </button>
        <button class="menu-item" @click="handleMenuAction('insert')">
          <span class="menu-icon">→</span> 插入路径
        </button>
        <button class="menu-item" @click="handleMenuAction('copyName')">
          <span class="menu-icon">◎</span> 复制名称
        </button>
        <button class="menu-item" @click="handleMenuAction('copyPath')">
          <span class="menu-icon">⊞</span> 复制路径
        </button>
        <button class="menu-item" @click="handleMenuAction('copy')">
          <span class="menu-icon">⎘</span> 复制到...
        </button>
        <button class="menu-item" @click="handleMenuAction('move')">
          <span class="menu-icon">→</span> 移动到...
        </button>
        <button class="menu-item" @click="handleMenuAction('rename')">
          <span class="menu-icon">✎</span> 重命名
        </button>
        <div class="menu-divider"></div>
        <button class="menu-item" @click="handleMenuAction('newFile')">
          <span class="menu-icon">+</span> 新建文件
        </button>
        <button class="menu-item" @click="handleMenuAction('newFolder')">
          <span class="menu-icon">+</span> 新建文件夹
        </button>
        <div class="menu-divider"></div>
        <button class="menu-item danger" @click="handleMenuAction('delete')">
          <span class="menu-icon">🗑</span> 移至回收站
        </button>
      </div>
      <div v-if="contextMenuVisible" class="context-menu-overlay" @click="closeContextMenu"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

const searchMode = ref<'name' | 'content'>('name')
const searchQuery = ref('')
const typeFilter = ref<'all' | 'file' | 'directory'>('all')
const hideDotFiles = ref(true)
const selectedPath = ref('')
const expandedItems = ref(new Set<string>())
const contextMenuVisible = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextMenuItem = ref<any>(null)

interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  icon: string
  size?: string
  depth: number
  children?: FileNode[]
}

const fileTree: FileNode[] = [
  {
    name: 'src',
    path: 'src',
    type: 'directory',
    icon: '▣',
    depth: 0,
    children: [
      { name: 'components', path: 'src/components', type: 'directory', icon: '▣', depth: 1 },
      { name: 'hooks', path: 'src/hooks', type: 'directory', icon: '▣', depth: 1 },
      { name: 'lib', path: 'src/lib', type: 'directory', icon: '▣', depth: 1 },
      { name: 'App.tsx', path: 'src/App.tsx', type: 'file', icon: 'M', size: '4.2KB', depth: 1 },
      { name: 'index.tsx', path: 'src/index.tsx', type: 'file', icon: 'M', size: '1.8KB', depth: 1 },
    ]
  },
  {
    name: 'package.json',
    path: 'package.json',
    type: 'file',
    icon: '{ }',
    size: '2.1KB',
    depth: 0
  },
  {
    name: 'README.md',
    path: 'README.md',
    type: 'file',
    icon: 'M',
    size: '8.5KB',
    depth: 0
  },
  {
    name: '.gitignore',
    path: '.gitignore',
    type: 'file',
    icon: '□',
    size: '0.3KB',
    depth: 0
  },
  {
    name: 'images',
    path: 'images',
    type: 'directory',
    icon: '▣',
    depth: 0,
    children: [
      { name: 'logo.png', path: 'images/logo.png', type: 'file', icon: '▧', size: '128KB', depth: 1 },
      { name: 'banner.webp', path: 'images/banner.webp', type: 'file', icon: '▧', size: '256KB', depth: 1 },
    ]
  },
  {
    name: 'utils.ts',
    path: 'utils.ts',
    type: 'file',
    icon: '<>',
    size: '3.4KB',
    depth: 0
  },
  {
    name: 'config.yaml',
    path: 'config.yaml',
    type: 'file',
    icon: '□',
    size: '1.1KB',
    depth: 0
  },
]

const flattenTree = (nodes: FileNode[], depth = 0): FileNode[] => {
  const result: FileNode[] = []
  for (const node of nodes) {
    result.push({ ...node, depth: node.depth ?? depth })
    if (node.children && expandedItems.value.has(node.path)) {
      result.push(...flattenTree(node.children, depth + 1))
    }
  }
  return result
}

const visibleFiles = computed(() => {
  let files = flattenTree(fileTree)
  if (hideDotFiles.value) {
    files = files.filter(f => !f.name.startsWith('.'))
  }
  if (typeFilter.value !== 'all') {
    files = files.filter(f => f.type === typeFilter.value)
  }
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    files = files.filter(f => f.name.toLowerCase().includes(q))
  }
  return files
})

const hasChildren = (item: FileNode) => {
  const findNode = (nodes: FileNode[]): FileNode | null => {
    for (const n of nodes) {
      if (n.path === item.path) return n
      if (n.children) {
        const found = findNode(n.children)
        if (found) return found
      }
    }
    return null
  }
  const node = findNode(fileTree)
  return node?.children && node.children.length > 0
}

const toggleExpand = (item: FileNode) => {
  if (expandedItems.value.has(item.path)) {
    expandedItems.value.delete(item.path)
  } else {
    expandedItems.value.add(item.path)
  }
}

const selectItem = (item: FileNode) => {
  selectedPath.value = item.path
}

const handleDoubleClick = (item: FileNode) => {
  if (item.type === 'directory') {
    toggleExpand(item)
  } else {
    console.log('Insert path:', item.path)
  }
}

const openContextMenu = (event: MouseEvent, item: FileNode) => {
  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  contextMenuItem.value = item
  contextMenuVisible.value = true
}

const closeContextMenu = () => {
  contextMenuVisible.value = false
  contextMenuItem.value = null
}

const handleMenuAction = (action: string) => {
  console.log('Action:', action, 'on', contextMenuItem.value?.name)
  closeContextMenu()
}

const showContextMenu = (e: MouseEvent) => {
  contextMenuX.value = e.clientX
  contextMenuY.value = e.clientY
  contextMenuItem.value = null
  contextMenuVisible.value = true
}

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') closeContextMenu()
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<style scoped>
:root {
  --accent: 10 132 255;
  --bg-0: 12 13 15;
  --bg-1: 24 25 28;
  --bg-2: 42 43 48;
  --text-1: 245 245 247;
  --text-2: 174 174 178;
  --text-3: 116 116 122;
  --glass-blur: 11px;
  --glass-saturate: 180%;
  --glass-fill: rgb(255 255 255 / 5%);
  --glass-rim: rgb(255 255 255 / 16%);
  --glass-highlight: rgb(255 255 255 / 30%);
  --glass-shadow: 0 4px 16px rgb(0 0 0 / 0.18);
}

.demo-container {
  padding: 32px;
  min-height: 100vh;
  background:
    radial-gradient(ellipse 80% 50% at 20% 40%, rgb(var(--accent) / 0.12) 0%, transparent 50%),
    radial-gradient(ellipse 60% 40% at 80% 70%, rgb(48 209 88 / 0.06) 0%, transparent 45%),
    rgb(var(--bg-0));
}

.glass-panel {
  width: 320px;
  border-radius: 16px;
  border: 1px solid var(--glass-rim);
  background: var(--glass-fill);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  box-shadow: var(--glass-shadow);
  overflow: hidden;
  position: relative;
}

.toolbar {
  padding: 10px 12px;
  border-bottom: 1px solid rgb(255 255 255 / 8%);
}

.toolbar-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.glass-select {
  flex: 1;
  min-width: 0;
  padding: 5px 10px;
  border-radius: 10px;
  border: 1px solid var(--glass-rim);
  background: rgb(255 255 255 / 4%);
  color: rgb(var(--text-1));
  font-size: 11px;
  font-family: inherit;
  outline: none;
  cursor: pointer;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.glass-select-sm {
  padding: 4px 8px;
  border-radius: 8px;
  border: 1px solid var(--glass-rim);
  background: rgb(255 255 255 / 4%);
  color: rgb(var(--text-2));
  font-size: 10px;
  font-family: inherit;
  outline: none;
  cursor: pointer;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.glass-chip {
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--glass-rim);
  background: rgb(255 255 255 / 4%);
  color: rgb(var(--text-3));
  font-size: 11px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s ease;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.glass-chip:hover {
  background: rgb(255 255 255 / 8%);
  color: rgb(var(--text-1));
  border-color: rgb(255 255 255 / 24%);
}

.search-bar {
  padding: 8px 12px;
  border-bottom: 1px solid rgb(255 255 255 / 8%);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.search-toggle {
  display: flex;
  border-radius: 8px;
  border: 1px solid var(--glass-rim);
  background: rgb(255 255 255 / 3%);
  padding: 2px;
  gap: 2px;
}

.toggle-btn {
  flex: 1;
  padding: 4px 8px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: rgb(var(--text-3));
  font-size: 10px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s ease;
  text-transform: capitalize;
}

.toggle-btn.active {
  background: rgb(var(--accent) / 20%);
  color: rgb(var(--accent));
  border: 1px solid rgb(var(--accent) / 30%);
}

.toggle-btn:hover:not(.active) {
  background: rgb(255 255 255 / 5%);
  color: rgb(var(--text-2));
}

.search-input-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.glass-input {
  flex: 1;
  min-width: 0;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid var(--glass-rim);
  background: rgb(255 255 255 / 4%);
  color: rgb(var(--text-1));
  font-size: 11px;
  font-family: monospace;
  outline: none;
}

.glass-input::placeholder {
  color: rgb(var(--text-3) / 0.6);
}

.glass-input:focus {
  border-color: rgb(var(--accent) / 40%);
  background: rgb(255 255 255 / 6%);
}

.toolbar-icon {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: rgb(var(--text-3));
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.toolbar-icon:hover {
  background: rgb(255 255 255 / 8%);
  color: rgb(var(--text-1));
  border-color: var(--glass-rim);
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.file-list {
  max-height: 420px;
  overflow-y: auto;
  padding: 4px 0;
}

.file-list::-webkit-scrollbar {
  width: 8px;
}

.file-list::-webkit-scrollbar-track {
  background: rgb(255 255 255 / 2%);
  border-radius: 4px;
}

.file-list::-webkit-scrollbar-thumb {
  background: rgb(255 255 255 / 15%);
  border-radius: 4px;
}

.file-list::-webkit-scrollbar-thumb:hover {
  background: rgb(255 255 255 / 25%);
}

.tree-node {
  display: flex;
  align-items: center;
  min-height: 26px;
  padding-right: 8px;
}

.expand-btn {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: rgb(var(--text-3));
  font-size: 10px;
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.1s ease;
}

.expand-btn:hover {
  color: rgb(var(--accent));
}

.expand-placeholder {
  width: 16px;
  flex-shrink: 0;
}

.file-item {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.1s ease;
}

.file-item:hover {
  background: rgb(255 255 255 / 6%);
}

.file-item.selected {
  background: rgb(var(--accent) / 15%);
}

.file-item.selected .file-name {
  color: rgb(var(--accent));
}

.file-icon {
  width: 14px;
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-family: monospace;
  flex-shrink: 0;
  color: rgb(var(--text-3));
}

.file-icon.directory {
  color: #dcb67a;
}

.file-icon:not(.directory):not([class*="▧"]) {
  color: rgb(var(--text-2));
}

.file-icon:has(+ .file-name[class*="M"]) {
  color: #79d2a6;
}

.file-name {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  font-family: monospace;
  color: rgb(var(--text-2));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-size {
  font-size: 9px;
  color: rgb(var(--text-3));
  font-family: monospace;
  flex-shrink: 0;
}

.empty-dir {
  font-size: 9px;
  color: rgb(var(--text-3) / 0.6);
  font-family: monospace;
  flex-shrink: 0;
}

.context-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 99;
}

.context-menu {
  position: fixed;
  z-index: 100;
  min-width: 160px;
  padding: 4px;
  border-radius: 12px;
  border: 1px solid var(--glass-rim);
  background: rgb(24 25 28 / 0.85%);
  backdrop-filter: blur(14px) saturate(180%);
  -webkit-backdrop-filter: blur(14px) saturate(180%);
  box-shadow: 0 8px 32px rgb(0 0 0 / 0.28);
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: rgb(var(--text-2));
  font-size: 11px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: all 0.1s ease;
}

.menu-item:hover {
  background: rgb(255 255 255 / 10%);
  color: rgb(var(--text-1));
}

.menu-item.danger {
  color: rgb(255 69 58);
}

.menu-item.danger:hover {
  background: rgb(255 69 58 / 12%);
}

.menu-icon {
  width: 14px;
  font-size: 11px;
  text-align: center;
}

.menu-divider {
  height: 1px;
  margin: 4px 8px;
  background: rgb(255 255 255 / 8%);
}
</style>
