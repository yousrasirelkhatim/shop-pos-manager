(function () {
  var form = document.getElementById('loginForm');
  if (!form) return;
  form.addEventListener('submit', function (event) {
    event.preventDefault();
  });
})();
