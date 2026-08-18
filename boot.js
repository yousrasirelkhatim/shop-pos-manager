(function () {
  var form = document.getElementById('loginForm');
  var errorBox = document.getElementById('loginError');
  if (!form) return;
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    event.stopPropagation();
    if (!window.__managerAppReady && errorBox && !errorBox.textContent) {
      errorBox.textContent = 'جاري تحميل اللوحة... اضغطي دخول مرة ثانية بعد ثانية.';
    }
  }, true);
})();
