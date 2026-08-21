(function () {
  var URL = 'https://rdluymzietxpdvxmomth.supabase.co';
  var KEY = 'sb_publishable_VR3-Ls_Dv2rLP4jgm-O0Dw_h4tb6e9L';
  var form = document.getElementById('loginForm');
  var button = document.getElementById('loginButton');
  var emailEl = document.getElementById('email');
  var passEl = document.getElementById('password');
  var errorEl = document.getElementById('loginError');
  var loginView = document.getElementById('loginView');
  var dashboard = document.getElementById('dashboard');

  function savedSession() {
    try {
      var raw = localStorage.getItem('managerSession');
      var data = raw ? JSON.parse(raw) : null;
      return data && data.access_token ? data : null;
    } catch (_error) {
      return null;
    }
  }

  function showLogin() {
    if (loginView) loginView.classList.remove('hidden');
    if (dashboard) dashboard.classList.add('hidden');
  }

  function showDash() {
    if (loginView) loginView.classList.add('hidden');
    if (dashboard) dashboard.classList.remove('hidden');
  }

  function restoreIfPossible() {
    var saved = savedSession();
    if (!saved) {
      showLogin();
      return;
    }
    window.__managerSession = saved;
    showDash();
    if (typeof window.__managerAfterLogin === 'function') {
      window.__managerAfterLogin();
    } else {
      window.__pendingManagerRestore = true;
    }
  }

  restoreIfPossible();
  [emailEl, passEl].forEach(function (field) {
    if (!field) return;
    field.addEventListener('focus', function () {
      field.removeAttribute('readonly');
    });
  });
  if (!form || !button) return;

  var busy = false;
  button.disabled = false;
  button.removeAttribute('disabled');

  function setError(message) {
    if (errorEl) errorEl.textContent = message || '';
  }

  function finish() {
    busy = false;
    button.disabled = false;
    button.textContent = 'دخول اللوحة';
  }

  function fallbackLogin() {
    var email = (emailEl && emailEl.value || '').trim();
    var password = passEl && passEl.value || '';
    setError('');
    if (!email || !password) {
      setError('اكتبي البريد وكلمة المرور ثم اضغطي دخول');
      finish();
      return;
    }
    fetch(URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: {
        apikey: KEY,
        Authorization: 'Bearer ' + KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email: email, password: password })
    }).then(function (response) {
      return response.json().then(function (body) {
        return { ok: response.ok, body: body };
      });
    }).then(function (result) {
      if (!result.ok) {
        var msg = result.body.error_description || result.body.msg || 'بيانات الدخول غير صحيحة';
        if (/invalid login credentials/i.test(msg)) {
          msg = 'البريد أو كلمة المرور غير صحيحة';
        }
        throw new Error(msg);
      }
      window.__managerSession = result.body;
      try { localStorage.setItem('managerSession', JSON.stringify(result.body)); } catch (_error) {}
      showDash();
      if (typeof window.__managerAfterLogin === 'function') {
        return window.__managerAfterLogin();
      }
    }).catch(function (error) {
      setError(error.message || 'تعذر الدخول. تأكد من الإنترنت.');
      showLogin();
    }).then(finish);
  }

  function doLogin(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (busy) return;
    busy = true;
    button.disabled = true;
    button.textContent = 'جاري الدخول...';
    setError('');
    if (typeof window.__managerHandleLogin === 'function') {
      Promise.resolve(window.__managerHandleLogin()).catch(function (error) {
        setError(error.message || 'تعذر الدخول');
      }).then(finish);
      return;
    }
    fallbackLogin();
  }

  form.addEventListener('submit', doLogin);
})();
