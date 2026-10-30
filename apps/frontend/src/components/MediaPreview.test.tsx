import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MediaPreview } from './MediaPreview'

const url = 'http://localhost:3001/api/hosts/local/files/raw/root-0/clip.mp4'
const labels = { failed: 'Media failed to load' }

describe('MediaPreview', () => {
  it('renders a video element with metadata preload and controls', () => {
    render(<MediaPreview kind="video" name="clip.mp4" url={url} size={1024} labels={labels} />)
    const video = screen.getByTestId('media-video') as HTMLVideoElement
    expect(video.tagName).toBe('VIDEO')
    expect(video.getAttribute('src')).toBe(url)
    expect(video.controls).toBe(true)
    expect(video.getAttribute('preload')).toBe('metadata')
    expect(video.getAttribute('aria-label')).toBe('clip.mp4')
  })

  it('renders an audio element for audio files', () => {
    render(<MediaPreview kind="audio" name="track.mp3" url={url} labels={labels} />)
    const audio = screen.getByTestId('media-audio') as HTMLAudioElement
    expect(audio.tagName).toBe('AUDIO')
    expect(audio.getAttribute('src')).toBe(url)
    expect(audio.controls).toBe(true)
    expect(screen.queryByTestId('media-video')).toBeNull()
  })

  it('swaps in the failure label when the source errors', () => {
    render(<MediaPreview kind="video" name="clip.mp4" url={url} labels={labels} />)
    fireEvent.error(screen.getByTestId('media-video'))
    expect(screen.getByTestId('media-error').textContent).toBe('Media failed to load')
    expect(screen.queryByTestId('media-video')).toBeNull()
  })
})
