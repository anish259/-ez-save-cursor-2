(() => {
  const form = document.querySelector('.download-form');
  const input = document.querySelector('.url-input');
  const button = document.querySelector('.download-btn');
  const btnSpinner = document.querySelector('.btn-spinner');
  let progressBar;

  const toast = (msg) => {
    alert(msg);
  };

  const startLoading = () => {
    button.setAttribute('disabled', 'true');
    button.style.opacity = '0.7';
  };
  const stopLoading = () => {
    button.removeAttribute('disabled');
    button.style.opacity = '1';
  };

  async function fetchInfo(url) {
    const resp = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
    if (!resp.ok) throw new Error('Failed to fetch video info');
    return resp.json();
  }

  function renderChoiceSheet(info) {
    const container = document.createElement('div');
    container.className = 'choice-sheet';
    container.innerHTML = `
      <div class="sheet">
        <div class="sheet-head">
          <div class="meta">
            ${info.thumbnail ? `<img class="thumb" src="${info.thumbnail}" alt="thumbnail"/>` : ''}
            <div class="text">
              <div class="title">${info.title || 'Video'}</div>
              <div class="uploader">${info.uploader || ''}</div>
            </div>
          </div>
          <button class="close">✕</button>
        </div>
        <div class="quick">
          <button data-choice="best" class="opt primary">Best (Auto)</button>
        </div>
        <div class="quick">
          <button data-choice="144p" class="opt">144p</button>
          <button data-choice="240p" class="opt">240p</button>
          <button data-choice="360p" class="opt">360p</button>
          <button data-choice="480p" class="opt">480p</button>
          <button data-choice="720p" class="opt">720p</button>
          <button data-choice="1080p" class="opt">1080p</button>
          <button data-choice="1440p" class="opt">1440p</button>
          <button data-choice="2160p" class="opt">2160p (4K)</button>
        </div>
        <div class="quick">
          <button data-choice="audio-m4a" class="opt">Audio M4A</button>
          <button data-choice="audio-mp3" class="opt">Audio MP3</button>
          <button data-choice="audio-aac" class="opt">Audio AAC</button>
        </div>
      </div>
    `;
    document.body.appendChild(container);

    const closeBtn = container.querySelector('.close');
    closeBtn.onclick = () => container.remove();

    container.querySelectorAll('.opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        startDownload({ choice: btn.getAttribute('data-choice') });
        container.remove();
      });
    });
  }

  async function startDownload(params) {
    const url = input.value.trim();
    if (!url) return toast('Please paste a YouTube URL');
    try {
      startLoading();
      ensureProgress();
      setProgress(5, 'Preparing...');
      
      const qs = new URLSearchParams({ url, ...(params || {}) }).toString();
      const resp = await fetch(`/api/download?${qs}`);
      if (!resp.ok) throw new Error('Download failed');
      
      setProgress(25, 'Downloading...');
      
      // Simulate progress while downloading
      const progressInterval = setInterval(() => {
        const current = progressBar?.querySelector('.progress-fill')?.style.width?.replace('%', '') || 25;
        const next = Math.min(95, parseInt(current) + Math.random() * 10);
        setProgress(next, 'Downloading...');
      }, 500);
      
      const blob = await resp.blob();
      clearInterval(progressInterval);
      
      setProgress(100, 'Finalizing...');
      
      const cd = resp.headers.get('Content-Disposition') || '';
      const match = cd.match(/filename="?([^";]+)"?/i);
      const filename = match ? match[1] : 'download';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      
      hideProgress();
    } catch (e) {
      hideProgress();
      toast(e.message || 'Something went wrong');
    } finally {
      stopLoading();
    }
  }

  function ensureProgress() {
    if (progressBar) return;
    const bar = document.createElement('div');
    bar.className = 'progress-wrap';
    bar.innerHTML = `<div class="progress"><div class="progress-fill"></div></div><div class="progress-label">0%</div>`;
    const anchor = document.querySelector('.download-form');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(bar, anchor.nextSibling);
    else (document.querySelector('.hero-inner') || document.body).appendChild(bar);
    progressBar = bar;
  }
  function setProgress(p, label) {
    if (!progressBar) return;
    const fill = progressBar.querySelector('.progress-fill');
    const txt = progressBar.querySelector('.progress-label');
    fill.style.width = `${Math.max(0, Math.min(100, p))}%`;
    txt.textContent = label || `${p.toFixed(0)}%`;
  }
  function hideProgress() {
    if (progressBar) { progressBar.remove(); progressBar = null; }
  }

  form.addEventListener('submit', (e) => e.preventDefault());
  button.addEventListener('click', async () => {
    const url = input.value.trim();
    if (!url) return toast('Please paste a YouTube URL');
    try {
      startLoading();
      const info = await fetchInfo(url);
      renderChoiceSheet(info);
    } catch (e) {
      toast(e.message || 'Could not fetch info');
    } finally {
      stopLoading();
    }
  });
})();


