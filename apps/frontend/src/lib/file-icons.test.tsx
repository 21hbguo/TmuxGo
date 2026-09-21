import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SiDocker, SiGit, SiGnubash, SiMarkdown, SiNpm, SiTypescript, SiVitest } from 'react-icons/si'
import { VscFile, VscFileMedia, VscFolder, VscFolderOpened, VscGear } from 'react-icons/vsc'
import { getFileIcon, resolveFileIcon } from './file-icons'

describe('file-icons', () => {
  it('maps known extensions to brand icons', () => {
    expect(resolveFileIcon('src/index.ts', 'file').icon).toBe(SiTypescript)
    expect(resolveFileIcon('README-note.txt.md', 'file').icon).toBe(SiMarkdown)
    expect(resolveFileIcon('bin/deploy.sh', 'file').icon).toBe(SiGnubash)
    expect(resolveFileIcon('img/photo.png', 'file').icon).toBe(VscFileMedia)
    expect(resolveFileIcon('plain.xyz', 'file').icon).toBe(VscFile)
    expect(resolveFileIcon('noext', 'file').icon).toBe(VscFile)
  })
  it('prefers exact filename matches over extension', () => {
    // package.json 是 npm 图标而非通用 json
    expect(resolveFileIcon('package.json', 'file').icon).toBe(SiNpm)
    expect(resolveFileIcon('tsconfig.build.json', 'file').icon).toBe(SiTypescript)
    expect(resolveFileIcon('Dockerfile', 'file').icon).toBe(SiDocker)
    expect(resolveFileIcon('docker-compose.prod.yml', 'file').icon).toBe(SiDocker)
    expect(resolveFileIcon('.gitignore', 'file').icon).toBe(SiGit)
    expect(resolveFileIcon('.env.local', 'file').icon).toBe(VscGear)
    expect(resolveFileIcon('app.test.ts', 'file').icon).toBe(SiVitest)
  })
  it('switches directory icons by open state', () => {
    expect(resolveFileIcon('src', 'directory').icon).toBe(VscFolder)
    expect(resolveFileIcon('src', 'directory', true).icon).toBe(VscFolderOpened)
    expect(resolveFileIcon('src', 'directory', false).icon).toBe(VscFolder)
  })
  it('dims hidden files', () => {
    const { container } = render(<>{getFileIcon('.env', 'file')}</>)
    expect(container.querySelector('span')?.className).toContain('opacity-60')
    const visible = render(<>{getFileIcon('normal.txt', 'file')}</>)
    expect(visible.container.querySelector('span')?.className).not.toContain('opacity-60')
  })
})
