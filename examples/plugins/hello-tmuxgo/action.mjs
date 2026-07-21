const context = JSON.parse(process.env.TMUXGO_CONTEXT_JSON || '{}')
process.stdout.write(`host=${context.hostId || '-'} session=${context.sessionId || '-'} pane=${context.paneId || '-'}`)
