                                                                                        
const clearBtn = document.getElementById("clear-btn");
const newFileBtn = document.getElementById("new-file-btn");

const saveBtn = document.getElementById("save-btn");
const downloadBtn = document.getElementById("download-btn");
const runPreviewBtn = document.getElementById('run-preview-btn');

const tabsList = document.getElementById("tabs-list");
const editorContainer = document.querySelector(".editor-container");

const previewContainer = document.querySelector(".preview-container");

const newFileModal = document.getElementById("new-file-modal");
const createFileBtn = document.getElementById("create-file-btn");
const cancelFileBtn = document.getElementById("cancel-file-btn");
const fileLanguageSelect = document.getElementById("file-language");
const fileNameInput = document.getElementById("file-name");
const closeNewFileBtn = document.getElementById("close-new-file");

const fpsCounter = document.getElementById("fps-counter");
const fpsDisplay = document.getElementById("fps");

const settingsBtn = document.getElementById("settings-btn");
const settingsModal = document.getElementById("settings-modal");
const closeSettingsBtn = document.getElementById("close-settings");
const themeSelect = document.getElementById("theme-select");
const fontSizeSlider = document.getElementById("font-size");
const fontSizeValue = document.getElementById("font-size-value");
const autoRunToggle = document.getElementById("auto-run-toggle");
const lineNumbersToggle = document.getElementById("line-numbers-toggle");
const tabSizeSelect = document.getElementById("tab-size");
const showFPSToggle = document.getElementById("show-fps-toggle");
const autosaveToggle = document.getElementById("autosave-toggle");
const shortcutsToggle = document.getElementById("shortcuts-toggle");

const notificationContainer = document.getElementById("notification-container"); 
const sidebarFilesList = document.getElementById("sidebar-files-list"); 
const searchFilesInput = document.getElementById("search-files"); 

const shortcutsModal = document.getElementById("shortcuts-modal");
const closeShortcutsBtn = document.getElementById("close-shortcuts");


let files = [];
let activeFileId = null;
let editors = {}; 
let previews = {}; 


let showFPS = true;
let lastTime = performance.now();
let frames = 0;
let fps = 0;


let debounceTimer;
let previewTimer;
const DEBOUNCE_DELAY = 300; 


let autosaveInterval;
let initializing = true;
let preserveUnreadableSave = false;
const MAX_EDITOR_FILES = 64;
const MAX_EDITOR_CONTENT = 512 * 1024;
const MAX_EDITOR_TOTAL = 2 * 1024 * 1024;
const EDITOR_LANGUAGES = ['html', 'css', 'javascript', 'python', 'ruby', 'typescript', 'java', 'csharp', 'php', 'go', 'swift', 'kotlin', 'rust'];
const EDITOR_THEMES = ['dark', 'light', 'solarized', 'dracula', 'monokai', 'github-dark'];

function validateSavedEditorData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.files) || data.files.length > MAX_EDITOR_FILES) {
    throw new Error('Invalid saved editor data');
  }
  const ids = new Set();
  const names = new Set();
  let total = 0;
  for (const file of data.files) {
    if (!file || !Number.isSafeInteger(file.id) || file.id <= 0 || file.id >= Number.MAX_SAFE_INTEGER - MAX_EDITOR_FILES || ids.has(file.id) ||
        typeof file.name !== 'string' || !file.name.trim() || file.name.length > 128 || /[\x00-\x1f\\/]/.test(file.name) || names.has(file.name.toLowerCase()) ||
        !EDITOR_LANGUAGES.includes(file.language) || typeof file.content !== 'string' || file.content.length > MAX_EDITOR_CONTENT) {
      throw new Error('Invalid saved file');
    }
    ids.add(file.id);
    names.add(file.name.toLowerCase());
    total += file.content.length;
  }
  if (total > MAX_EDITOR_TOTAL) throw new Error('Saved project exceeds the editor size limit');
  return {
    files: data.files.map(({ id, name, language, content }) => ({ id, name, language, content })),
    theme: EDITOR_THEMES.includes(data.theme) ? data.theme : 'dark',
    fontSize: Number.isFinite(Number(data.fontSize)) ? Math.min(24, Math.max(12, Number(data.fontSize))) : 14,
    tabSize: ['2', '4', '8'].includes(String(data.tabSize)) ? String(data.tabSize) : '4',
    ...Object.fromEntries(['autoRun', 'showLineNumbers', 'showFPS', 'autosave', 'showShortcuts'].map(key => [key, typeof data[key] === 'boolean' ? data[key] : true]))
  };
}


document.addEventListener("DOMContentLoaded", initialize, { once: true });


clearBtn.addEventListener("click", handleClear);
newFileBtn.addEventListener("click", openNewFileModal);
createFileBtn.addEventListener("click", handleCreateFile);
cancelFileBtn.addEventListener("click", closeNewFileModal);
closeNewFileBtn.addEventListener("click", closeNewFileModal);

settingsBtn.addEventListener("click", openSettingsModal);
closeSettingsBtn.addEventListener("click", closeSettingsModal);
themeSelect.addEventListener("change", changeTheme);
fontSizeSlider.addEventListener("input", changeFontSize);
autoRunToggle.addEventListener("change", toggleAutoRun);
lineNumbersToggle.addEventListener("change", toggleLineNumbers);
tabSizeSelect.addEventListener("change", changeTabSize);
showFPSToggle.addEventListener("change", toggleFPS);
autosaveToggle.addEventListener("change", toggleAutosave);
shortcutsToggle.addEventListener("change", toggleShortcuts);

saveBtn.addEventListener("click", saveToLocalStorage);
downloadBtn.addEventListener("click", downloadAsFile);
runPreviewBtn.addEventListener('click', runActivePreview);

sidebarFilesList.addEventListener("click", function(event) {
  const target = event.target;
  const fileItem = target.closest("li");
  if (!fileItem) return;

  const fileId = parseInt(fileItem.getAttribute("data-id"));

  if (target.classList.contains("delete-sidebar-file")) {
    handleDeleteFile(fileId);
  } else {
    setActiveFile(fileId);
  }
});

tabsList.addEventListener("click", function(event) {
  const target = event.target;
  const tab = target.closest("li");
  if (!tab) return;

  const fileId = parseInt(tab.getAttribute("data-id"));

  if (target.classList.contains("delete-tab")) {
    handleDeleteFile(fileId);
  } else {
    setActiveFile(fileId);
  }
});


searchFilesInput.addEventListener("input", function() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    filterFiles(searchFilesInput.value.trim().toLowerCase());
  }, DEBOUNCE_DELAY);
});


document.addEventListener("keydown", handleKeyboardShortcuts);


shortcutsToggle.addEventListener("change", function() {
  if (shortcutsToggle.checked) {
    openShortcutsModal();
  } else {
    closeShortcutsModal();
  }
});


closeShortcutsBtn.addEventListener("click", closeShortcutsModal);



   
                                 
                                                    
                                                                                
   
function showNotification(message, type = 'info') {
  const notification = document.createElement("div");
  notification.classList.add("notification", type);
  notification.textContent = message;
  
  notificationContainer.appendChild(notification);
  
  
  setTimeout(() => {
    notification.remove();
  }, 3000);
}

   
                                                                                           
   
function initialize() {
  let savedData;
  try {
    const raw = localStorage.getItem("amazingEditorData");
    if (raw && raw.length > MAX_EDITOR_TOTAL * 3) throw new Error('Saved editor data is too large');
    savedData = raw ? JSON.parse(raw) : null;
    if (savedData !== null) savedData = validateSavedEditorData(savedData);
  } catch (error) {
    preserveUnreadableSave = true;
    showNotification('Saved files could not be loaded. Automatic saves are paused to preserve them; download your new work or use Save to replace them.', 'error');
    savedData = null;
  }
  if (savedData) {
    const data = savedData;
    files = data.files || [];
    const theme = data.theme || 'dark';
    const fontSize = data.fontSize || 14;
    const autoRun = data.autoRun !== undefined ? data.autoRun : true;
    const showLineNumbers = data.showLineNumbers !== undefined ? data.showLineNumbers : true;
    const tabSize = data.tabSize || "4";
    const showFPSSetting = data.showFPS !== undefined ? data.showFPS : true;
    const autosave = data.autosave !== undefined ? data.autosave : true;
    const showShortcuts = data.showShortcuts !== undefined ? data.showShortcuts : true;

    applyTheme(theme);
    themeSelect.value = theme;
    
    fontSizeSlider.value = fontSize;
    fontSizeValue.textContent = `${fontSize}px`;
    autoRunToggle.checked = autoRun;
    lineNumbersToggle.checked = showLineNumbers;
    tabSizeSelect.value = tabSize;
    showFPSToggle.checked = showFPSSetting;
    autosaveToggle.checked = autosave;
    shortcutsToggle.checked = showShortcuts;

    toggleFPS();
    toggleAutosave();

    files.forEach(file => {
      addTab(file);
      addSidebarFile(file);
      addEditor(file);
      if (file.language.toLowerCase() === 'html') {
        addPreview(file);
      }
    });

    if (files.length > 0) {
      setActiveFile(files[0].id);
    } else {
      createNewFile("index", "html");
    }

    updateFontSize();

    showNotification("Loaded files and settings from LocalStorage.", "success");

  } else {
    createNewFile("index", "html");
    showNotification("Created default 'index.html' file.", "info");
  }

  
  let shortcutsClosed;
  try { shortcutsClosed = localStorage.getItem("shortcutsClosed"); } catch (error) {                                   }
  if (shortcutsClosed === "true" || savedData?.showShortcuts === false) {
    shortcutsModal.style.display = "none";
    shortcutsModal.setAttribute("aria-hidden", "true");
    shortcutsToggle.checked = false;
  } else {
    shortcutsModal.style.display = "flex";
    shortcutsModal.setAttribute("aria-hidden", "false");
    shortcutsToggle.checked = true;
  }

  updateFPS();
  initializing = false;
  if (preserveUnreadableSave) autosaveToggle.checked = false;
  toggleAutosave();
}

   
                                              
                                                    
                                                                   
   
function createNewFile(name, language) {
  if (files.length >= MAX_EDITOR_FILES) {
    showNotification(`This project can contain up to ${MAX_EDITOR_FILES} files.`, 'error');
    return;
  }
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 || /[\x00-\x1f\\/]/.test(name) || !EDITOR_LANGUAGES.includes(language)) {
    showNotification('Use a file name of 1–120 characters without slashes or control characters.', 'error');
    return;
  }
  const id = Math.max(Date.now(), ...files.map(file => file.id + 1));
  const extension = getExtension(language);
  let fileName = name.trim();

  
  if (!fileName.endsWith(extension)) {
    fileName += extension;
  }

  
  if (files.some(f => f.name.toLowerCase() === fileName.toLowerCase())) {
    showNotification(`A file named "${fileName}" already exists.`, "error");
    return;
  }

  const newFile = {
    id,
    name: fileName,
    language,
    content: ""
  };

  files.push(newFile);
  addTab(newFile);
  addSidebarFile(newFile);
  addEditor(newFile);
  if (newFile.language.toLowerCase() === 'html') {
    addPreview(newFile);
  }
  setActiveFile(id);
  saveToLocalStorage(true);

  showNotification(`Created new file "${fileName}".`, "success");
}

   
                                                
                                                       
                                                        
   
function getExtension(language) {
  const extensions = {
    html: ".html",
    css: ".css",
    javascript: ".js",
    python: ".py",
    ruby: ".rb",
    typescript: ".ts",
    java: ".java",
    csharp: ".cs",
    php: ".php",
    go: ".go",
    swift: ".swift",
    kotlin: ".kt",
    rust: ".rs"
  };
  return extensions[language.toLowerCase()] || ".txt";
}

   
                                  
                                          
   
function addTab(file) {
  const li = document.createElement("li");
  li.setAttribute("data-id", file.id);
  li.innerHTML = '<span></span> <button class="delete-tab" title="Delete File" aria-label="Delete File">&times;</button>';
  li.querySelector('span').textContent = file.name;
  tabsList.appendChild(li);
}

   
                                      
                                          
   
function addSidebarFile(file) {
  const li = document.createElement("li");
  li.setAttribute("data-id", file.id);
  li.innerHTML = `
    <span></span>
    <button class="delete-sidebar-file" title="Delete File" aria-label="Delete File">&times;</button>
  `;
  li.querySelector('span').textContent = file.name;
  sidebarFilesList.appendChild(li);
}

   
                                                                     
                                          
   
function addEditor(file) {
  const panel = document.createElement("div");
  panel.classList.add("editor-panel");
  panel.setAttribute("data-id", file.id);

  const header = document.createElement("div");
  header.classList.add("panel-header");
  header.textContent = file.name;

  const textarea = document.createElement("textarea");
  textarea.id = `editor-${file.id}`;
  textarea.placeholder = `Write your ${file.language.toUpperCase()} code here...`;
  textarea.value = file.content;

  panel.appendChild(header);
  panel.appendChild(textarea);
  editorContainer.appendChild(panel);

  
  const mode = getCodeMirrorMode(file.language);
  const theme = getCurrentTheme() === 'github-dark' ? 'github-dark' : getCurrentTheme();
  const editor = window.CodeMirror ? CodeMirror.fromTextArea(textarea, {
    lineNumbers: lineNumbersToggle.checked,
    mode: mode,
    theme: theme === 'dracula' ? 'dracula' : 'default',
    tabSize: parseInt(tabSizeSelect.value),
    indentWithTabs: false,
    autofocus: false,
    lineWrapping: true
  }) : {
    getValue: () => textarea.value,
    setValue: value => { textarea.value = value; handleInputDebounced(file.id); },
    getWrapperElement: () => textarea,
    setOption: () => {}, setSize: () => {}, refresh: () => {}, toTextArea: () => {},
    on: (event, listener) => textarea.addEventListener('input', listener)
  };

  
  editor.setOption("viewportMargin", 10);
  editor.setSize("100%", "100%"); 

  
  editor.on("change", () => {
    handleInputDebounced(file.id);
  });

  editors[file.id] = editor;
  editor.getWrapperElement().style.fontSize = `${fontSizeSlider.value}px`;
}

   
                                         
                                               
   
function addPreview(file) {
  const iframe = document.createElement("iframe");
  iframe.classList.add("preview-iframe");
  iframe.id = `preview-${file.id}`;
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.referrerPolicy = 'no-referrer';
  iframe.title = `Preview of ${file.name}`;
  iframe.srcdoc = autoRunToggle.checked ? '<h2>Preview ready</h2>' : '<!doctype html><html><body style="font:15px system-ui;color:#525260;padding:24px"><h2>Preview paused</h2><p>Your code is loaded. Choose <strong>Run Preview</strong> or enable Auto-Run in Settings to run it.</p></body></html>';
  previewContainer.appendChild(iframe);

  previews[file.id] = iframe;
}

   
                                                 
                                                       
                                                         
   
function getCodeMirrorMode(language) {
  const modes = {
    html: "htmlmixed",
    css: "css",
    javascript: "javascript",
    python: "python",
    ruby: "ruby",
    typescript: { name: "javascript", typescript: true },
    java: "text/x-java",
    csharp: "text/x-csharp",
    php: "php",
    go: "go",
    swift: "swift",
    kotlin: "text/x-kotlin",
    rust: "rust"
  };
  return modes[language.toLowerCase()] || "javascript";
}

   
                                                     
                                                          
   
function setActiveFile(id) {
  activeFileId = id;

  
  Array.from(tabsList.children).forEach(tab => {
    if (parseInt(tab.getAttribute("data-id")) === id) {
      tab.classList.add("active");
    } else {
      tab.classList.remove("active");
    }
  });

  
  Array.from(sidebarFilesList.children).forEach(fileItem => {
    if (parseInt(fileItem.getAttribute("data-id")) === id) {
      fileItem.classList.add("active");
    } else {
      fileItem.classList.remove("active");
    }
  });

  
  Array.from(editorContainer.children).forEach(panel => {
    if (parseInt(panel.getAttribute("data-id")) === id) {
      panel.classList.add("active");
      editors[id].refresh(); 
    } else {
      panel.classList.remove("active");
    }
  });

  
  Object.keys(previews).forEach(fileId => {
    const iframe = previews[fileId];
    if (parseInt(fileId) === id) {
      iframe.style.display = "block";
      if (autoRunToggle.checked) {
        const file = files.find(f => f.id === id);
        if (file && file.language.toLowerCase() === 'html') {
          updatePreview(file.id);
        }
      }
    } else {
      iframe.style.display = "none";
    }
  });
  updatePreviewControls();
}

function updatePreviewControls() {
  const active = files.find(file => file.id === activeFileId);
  runPreviewBtn.disabled = active?.language !== 'html';
  const header = previewContainer.querySelector('.preview-header');
  if (header) header.textContent = autoRunToggle.checked ? 'Preview · auto-run on' : 'Preview · auto-run paused · use Run Preview';
}

function runActivePreview() {
  const active = files.find(file => file.id === activeFileId);
  if (!active || active.language !== 'html') {
    showNotification('Select an HTML file to run its preview.', 'info');
    return;
  }
  files.forEach(file => { if (editors[file.id]) file.content = editors[file.id].getValue(); });
  const iframe = previews[active.id];
  if (iframe) iframe.style.display = 'block';
  updatePreview(active.id);
  updatePreviewControls();
}

   
                                                              
                                                              
   
function handleInputDebounced(fileId) {
  const file = files.find(f => f.id === fileId);
  if (file && editors[fileId]) file.content = editors[fileId].getValue();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    handleInput(fileId);
  }, DEBOUNCE_DELAY); 
}

   
                                                                              
                                                              
   
function handleInput(fileId) {
  const file = files.find(f => f.id === fileId);
  if (file) {
    const editor = editors[fileId];
    file.content = editor.getValue();
  }

  
  if (autoRunToggle.checked) {
    files.filter(file => file.language.toLowerCase() === 'html').forEach(file => updatePreview(file.id));
  }

  
  if (autosaveToggle.checked) {
    saveToLocalStorage(true);
  }
}

   
                                                            
                                                                                  
   
function updatePreview(htmlFileId) {
  const htmlFile = files.find(f => f.id === htmlFileId && f.language.toLowerCase() === 'html');
  if (!htmlFile) {
    const iframe = previews[htmlFileId];
    if (iframe) {
      iframe.srcdoc = "<h2>No Content to Preview</h2>";
    }
    return;
  }

  const cssFiles = files.filter(f => f.language.toLowerCase() === 'css');
  const jsFiles = files.filter(f => ['javascript', 'js'].includes(f.language.toLowerCase()));
  if (files.some(file => file.content.length > MAX_EDITOR_CONTENT) || files.reduce((total, file) => total + file.content.length, 0) > MAX_EDITOR_TOTAL) {
    showNotification('Preview paused: keep each file below 512 KB and the project below 2 MB. You can still download your work.', 'error');
    return;
  }

  let combinedHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Code preview</title>`;

  
  cssFiles.forEach(file => {
    combinedHTML += `<style>${file.content}</style>`;
  });

  combinedHTML += `</head>
<body>`;

  
  combinedHTML += `${htmlFile.content}`;

  
  jsFiles.forEach(file => {
    combinedHTML += `<script>${file.content}<\/script>`;
  });

  combinedHTML += `</body>
</html>`;

  
  const iframe = previews[htmlFileId];
  if (iframe) {
    iframe.srcdoc = combinedHTML;
  }
}

   
                                          
   
function saveToLocalStorage(silent = false) {
  if (initializing) return;
  if (preserveUnreadableSave) {
    if (silent === true || !confirm('Replace the saved project that could not be loaded? Download any work you need first.')) return;
  }
  files.forEach(file => {
    if (editors[file.id]) file.content = editors[file.id].getValue();
  });
  const data = {
    files,
    theme: getCurrentTheme(),
    fontSize: fontSizeSlider.value,
    autoRun: autoRunToggle.checked,
    showLineNumbers: lineNumbersToggle.checked,
    tabSize: tabSizeSelect.value,
    showFPS: showFPS,
    autosave: autosaveToggle.checked,
    showShortcuts: shortcutsToggle.checked
  };
  try {
    validateSavedEditorData(data);
    localStorage.setItem("amazingEditorData", JSON.stringify(data));
    preserveUnreadableSave = false;
    if (silent !== true) showNotification("Files and settings have been saved to LocalStorage.", "success");
  } catch (error) {
    showNotification("Files could not be saved. Download your work to keep a copy.", "error");
  }
}

   
                                                       
   
function downloadAsFile() {
  if (!activeFileId) {
    showNotification("No active file to download.", "error");
    return;
  }

  const file = files.find(f => f.id === activeFileId);
  if (!file) {
    showNotification("Active file not found.", "error");
    return;
  }

  file.content = editors[file.id].getValue();
  const blob = new Blob([file.content], { type: getMimeType(file.language) });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);

  showNotification(`Downloaded "${file.name}".`, "success");
}

   
                                           
                                                       
                                                   
   
function getMimeType(language) {
  const mimeTypes = {
    html: "text/html",
    css: "text/css",
    javascript: "application/javascript",
    python: "text/x-python",
    ruby: "text/x-ruby",
    typescript: "application/typescript",
    java: "text/x-java-source",
    csharp: "text/plain",
    php: "application/x-httpd-php",
    go: "text/plain",
    swift: "text/x-swift",
    kotlin: "text/x-kotlin",
    rust: "text/plain"
  };
  return mimeTypes[language.toLowerCase()] || "text/plain";
}

   
                                                  
   
function handleClear() {
  if (!activeFileId) {
    showNotification("No active file to clear.", "error");
    return;
  }

  const file = files.find(f => f.id === activeFileId);
  if (file) {
    const confirmClear = confirm(`Are you sure you want to clear the content of "${file.name}"?`);
    if (confirmClear) {
      file.content = "";
      const activeEditor = editors[activeFileId];
      if (activeEditor) {
        activeEditor.setValue("");
      }
      if (autoRunToggle.checked && file.language.toLowerCase() === 'html') {
        updatePreview(file.id);
      }
      if (autosaveToggle.checked) {
        saveToLocalStorage();
      }
      showNotification(`Cleared content of "${file.name}".`, "success");
    }
  }
}

   
                           
   
function openNewFileModal() {
  newFileModal.style.display = "flex";
  newFileModal.setAttribute("aria-hidden", "false");
  fileNameInput.focus();
}

   
                            
   
function closeNewFileModal() {
  newFileModal.style.display = "none";
  newFileModal.setAttribute("aria-hidden", "true");
  fileNameInput.value = "";
  fileLanguageSelect.value = "html";
}

   
                                                    
   
function handleCreateFile() {
  const language = fileLanguageSelect.value;
  const name = fileNameInput.value.trim();

  if (!name) {
    showNotification("Please enter a file name.", "error");
    return;
  }

  createNewFile(name, language);
  closeNewFileModal();
}

   
                           
   
function openSettingsModal() {
  settingsModal.style.display = "flex";
  settingsModal.setAttribute("aria-hidden", "false");
  themeSelect.focus();
}

   
                            
   
function closeSettingsModal() {
  settingsModal.style.display = "none";
  settingsModal.setAttribute("aria-hidden", "true");
}

   
                                            
   
function changeTheme() {
  const selectedTheme = themeSelect.value;
  applyTheme(selectedTheme);
  
  Object.values(editors).forEach(editor => {
    const theme = selectedTheme === 'dracula' ? 'dracula' : 'default';
    editor.setOption("theme", theme);
  });
  saveToLocalStorage();
  showNotification(`Theme changed to "${selectedTheme}".`, "info");
}

   
                                                       
                                              
   
function applyTheme(theme) {
  document.body.classList.remove('dark', 'light', 'solarized', 'dracula', 'monokai', 'github-dark');
  document.body.classList.add(theme);
}

   
                                                 
                                         
   
function getCurrentTheme() {
  const themes = ['dark', 'light', 'solarized', 'dracula', 'monokai', 'github-dark'];
  for (const theme of themes) {
    if (document.body.classList.contains(theme)) {
      return theme;
    }
  }
  return 'dark'; 
}

   
                                      
   
function changeFontSize() {
  const size = fontSizeSlider.value;
  fontSizeValue.textContent = `${size}px`;
  Object.values(editors).forEach(editor => {
    editor.getWrapperElement().style.fontSize = `${size}px`;
    editor.refresh();
  });
  saveToLocalStorage();
  showNotification(`Font size set to ${size}px.`, "info");
}

   
                                                        
   
function updateFontSize() {
  const size = fontSizeSlider.value;
  fontSizeValue.textContent = `${size}px`;
  Object.values(editors).forEach(editor => {
    editor.getWrapperElement().style.fontSize = `${size}px`;
    editor.refresh();
  });
}

   
                                       
   
function toggleAutoRun() {
  saveToLocalStorage();
  if (autoRunToggle.checked) {
    const activeFile = files.find(f => f.id === activeFileId);
    if (activeFile && activeFile.language.toLowerCase() === 'html') {
      updatePreview(activeFile.id);
    }
    showNotification("Auto-Run Preview enabled.", "info");
  } else {
    showNotification("Auto-Run Preview disabled.", "info");
  }
  updatePreviewControls();
}

   
                                         
   
function toggleLineNumbers() {
  const show = lineNumbersToggle.checked;
  Object.values(editors).forEach(editor => {
    editor.setOption("lineNumbers", show);
  });
  saveToLocalStorage();
  showNotification(`Line Numbers ${show ? 'enabled' : 'disabled'}.`, "info");
}

   
                                               
   
function changeTabSize() {
  const size = parseInt(tabSizeSelect.value);
  Object.values(editors).forEach(editor => {
    editor.setOption("tabSize", size);
    editor.setOption("indentUnit", size);
  });
  saveToLocalStorage();
  showNotification(`Tab size set to ${size}.`, "info");
}

   
                                     
   
function toggleFPS() {
  showFPS = showFPSToggle.checked;
  fpsCounter.style.display = showFPS ? "block" : "none";
  saveToLocalStorage();
  showNotification(`FPS Counter ${showFPS ? 'shown' : 'hidden'}.`, "info");
}

   
                               
   
function toggleAutosave() {
  clearInterval(autosaveInterval);
  if (autosaveToggle.checked) {
    
    autosaveInterval = setInterval(() => {
      saveToLocalStorage(true);
    }, 30000); 
    showNotification("Autosave enabled.", "info");
  } else {
    
    clearInterval(autosaveInterval);
    showNotification("Autosave disabled.", "info");
  }
}

   
                                       
   
function toggleShortcuts() {
  if (shortcutsToggle.checked) {
    openShortcutsModal();
  } else {
    closeShortcutsModal();
  }
}

   
                                     
   
function openShortcutsModal() {
  shortcutsToggle.checked = true;
  shortcutsModal.style.display = "flex";
  shortcutsModal.setAttribute("aria-hidden", "false");
  try { localStorage.setItem("shortcutsClosed", "false"); } catch (error) {                                               }
}

   
                                      
   
function closeShortcutsModal() {
  shortcutsToggle.checked = false;
  shortcutsModal.style.display = "none";
  shortcutsModal.setAttribute("aria-hidden", "true");
  try { localStorage.setItem("shortcutsClosed", "true"); } catch (error) {                                               }
}

   
                          
   
function updateFPS() {
  const update = () => {
    frames++;
    const now = performance.now();
    const delta = now - lastTime;
    if (delta >= 1000) {
      fps = Math.round((frames * 1000) / delta);
      fpsDisplay.textContent = fps;
      frames = 0;
      lastTime = now;
    }
    requestAnimationFrame(update);
  };
  requestAnimationFrame(update);
}

   
                          
                                                              
   
function handleDeleteFile(fileId) {
  const fileIndex = files.findIndex(f => f.id === fileId);
  if (fileIndex === -1) return;

  const file = files[fileIndex];
  const confirmDelete = confirm(`Are you sure you want to delete "${file.name}"?`);
  if (confirmDelete) {
    files.splice(fileIndex, 1);
    
    const tab = document.querySelector(`.tabs ul li[data-id="${fileId}"]`);
    if (tab) tab.remove();
    
    const sidebarFile = document.querySelector(`.sidebar ul li[data-id="${fileId}"]`);
    if (sidebarFile) sidebarFile.remove();
    
    const panel = document.querySelector(`.editor-panel[data-id="${fileId}"]`);
    if (panel) panel.remove();
    if (editors[fileId]) {
      editors[fileId].toTextArea();
      delete editors[fileId];
    }
    
    const iframe = previews[fileId];
    if (iframe) {
      iframe.remove();
      delete previews[fileId];
    }
    
    if (activeFileId === fileId) {
      if (files.length > 0) {
        setActiveFile(files[0].id);
      } else {
        activeFileId = null;
        
        editorContainer.innerHTML = "";
        previewContainer.innerHTML = `<div class="preview-header">Preview</div>`;
        previews = {};
        showNotification("No files left. Created a new default 'index.html' file.", "info");
        createNewFile("index", "html");
      }
    }
    if (autosaveToggle.checked) {
      saveToLocalStorage();
    }
    showNotification(`Deleted file "${file.name}".`, "success");
  }
}

   
                                                         
                                            
   
function filterFiles(query) {
  Array.from(sidebarFilesList.children).forEach(fileItem => {
    const fileName = fileItem.querySelector("span").textContent.toLowerCase();
    if (fileName.includes(query)) {
      fileItem.style.display = "flex";
    } else {
      fileItem.style.display = "none";
    }
  });
}

   
                             
                               
   
function handleKeyboardShortcuts(event) {
  if (event.ctrlKey || event.metaKey) {
    switch (event.key.toLowerCase()) {
      case 'enter':
        event.preventDefault();
        runActivePreview();
        break;
      case 'n':
        event.preventDefault();
        openNewFileModal();
        break;
      case 's':
        event.preventDefault();
        saveToLocalStorage();
        break;
      case 'd':
        event.preventDefault();
        downloadAsFile();
        break;
      case 'f':
        event.preventDefault();
        searchFilesInput.focus();
        break;
      case 'p':
        event.preventDefault();
        togglePreview();
        break;
      case 'c':
        if (event.shiftKey) {
          event.preventDefault();
          handleClear();
        }
        break;
      default:
        break;
    }
  }
}

   
                                           
   
function togglePreview() {
  if (activeFileId && files.find(f => f.id === activeFileId && f.language.toLowerCase() === 'html')) {
    const iframe = previews[activeFileId];
    if (iframe) {
      if (iframe.style.display === "none") {
        iframe.style.display = "block";
        updatePreview(activeFileId);
        showNotification("Preview Enabled.", "info");
      } else {
        iframe.style.display = "none";
        showNotification("Preview Disabled.", "info");
      }
    }
  } else {
    showNotification("No active HTML file to preview.", "error");
  }
}


window.addEventListener("click", function(event) {
  if (event.target === newFileModal) {
    closeNewFileModal();
  }
  if (event.target === settingsModal) {
    closeSettingsModal();
  }
  if (event.target === shortcutsModal) {
    closeShortcutsModal();
  }
});
