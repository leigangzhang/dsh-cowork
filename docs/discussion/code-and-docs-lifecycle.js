(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var stage = document.getElementById('stage');
  var progress = document.getElementById('progressFill');
  var hudCount = document.getElementById('hudCount');
  var live = document.getElementById('live');
  var total = slides.length;
  var index = 0;
  var transformBeforePrint = '';

  slides.forEach(function (slide, i) {
    var foot = document.createElement('footer');
    foot.className = 'foot';
    foot.setAttribute('aria-hidden', 'true');
    foot.innerHTML = '<span>代码与文档：怎么保留，怎么删除 · 演示稿</span><span>' +
      (slide.getAttribute('data-sec') || '') + '　·　' +
      String(i + 1).padStart(2, '0') + ' / ' + String(total).padStart(2, '0') + '</span>';
    slide.appendChild(foot);
    if (i > 0) {
      slide.setAttribute('aria-hidden', 'true');
      slide.setAttribute('inert', '');
    }
  });

  function show(n) {
    index = Math.max(0, Math.min(total - 1, n));
    slides.forEach(function (slide, i) {
      var active = i === index;
      slide.classList.toggle('is-active', active);
      if (active) {
        slide.removeAttribute('inert');
        slide.removeAttribute('aria-hidden');
      } else {
        slide.setAttribute('inert', '');
        slide.setAttribute('aria-hidden', 'true');
      }
    });
    progress.style.width = ((index + 1) / total * 100) + '%';
    hudCount.textContent = String(index + 1).padStart(2, '0') + ' / ' + String(total).padStart(2, '0');
    live.textContent = '第 ' + (index + 1) + ' 张，共 ' + total + ' 张：' + (slides[index].getAttribute('data-sec') || '');
    try { history.replaceState(null, '', '#' + (index + 1)); } catch (e) {}
  }

  function fit() {
    var scale = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
    stage.style.transform = 'scale(' + scale + ')';
  }

  function isEditable(target) {
    return target && target.closest && target.closest('button, a, input, textarea, select, [contenteditable="true"]');
  }

  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || isEditable(e.target)) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault(); show(index + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault(); show(index - 1);
    } else if (e.key === 'Home') {
      e.preventDefault(); show(0);
    } else if (e.key === 'End') {
      e.preventDefault(); show(total - 1);
    } else if (e.key.toLowerCase() === 'p') {
      e.preventDefault(); window.print();
    }
  });

  document.getElementById('prev').addEventListener('click', function () { show(index - 1); });
  document.getElementById('next').addEventListener('click', function () { show(index + 1); });
  window.addEventListener('resize', fit);
  window.addEventListener('hashchange', function () {
    var h = parseInt((location.hash || '').slice(1), 10);
    if (isFinite(h) && h > 0 && h - 1 !== index) show(h - 1);
  });

  var startX = null;
  var startY = null;
  stage.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse') return;
    startX = e.clientX; startY = e.clientY;
  });
  stage.addEventListener('pointerup', function (e) {
    if (startX === null) return;
    var dx = e.clientX - startX;
    var dy = e.clientY - startY;
    startX = null; startY = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) show(index + (dx < 0 ? 1 : -1));
  });

  window.addEventListener('beforeprint', function () {
    transformBeforePrint = stage.style.transform;
    stage.style.transform = 'none';
  });
  window.addEventListener('afterprint', function () {
    stage.style.transform = transformBeforePrint;
    fit();
  });

  fit();
  var initial = parseInt((location.hash || '').slice(1), 10);
  show(isFinite(initial) && initial > 0 ? initial - 1 : 0);
})();
