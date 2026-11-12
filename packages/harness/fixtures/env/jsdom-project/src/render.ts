// Writes into the document of whatever environment the file runs in.
module.exports = function render(text: string): string {
  const node = document.createElement('p')
  node.textContent = text
  document.body.appendChild(node)
  return document.body.innerHTML
}
