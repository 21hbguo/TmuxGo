const context = document.getElementById('context')
const output = document.getElementById('output')
tmuxgo.context.get().then((value) => { context.textContent = `${value.hostId} / ${value.sessionId || 'no session'}` }).catch((error) => { context.textContent = error.message })
document.getElementById('run').addEventListener('click', async () => {
  output.textContent = 'Running...'
  try {
    const result = await tmuxgo.actions.invoke('show-context')
    output.textContent = result.stdout || result.error || result.status
  } catch (error) {
    output.textContent = error.message
  }
})
