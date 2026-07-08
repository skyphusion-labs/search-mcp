// Embeddable ask widget. Vanilla JS, no build step. Streams answers from POST /ask.
//
// Usage:
//   <div id="docs-ask"></div>
//   <script defer src="/ask-widget.js"
//           data-endpoint="https://search.example.com/ask"
//           data-target="#docs-ask"
//           data-label="Ask the docs"
//           data-placeholder="How do I deploy?"
//           data-sitekey="<TURNSTILE_SITEKEY>"></script>
(function () {
  "use strict";
  var script = document.currentScript;
  var endpoint = script.getAttribute("data-endpoint") || "/ask";
  var targetSel = script.getAttribute("data-target") || "#docs-ask";
  var label = script.getAttribute("data-label") || "Ask";
  var placeholder = script.getAttribute("data-placeholder") || "Ask a question about the docs";
  var sitekey = script.getAttribute("data-sitekey") || "";

  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  ready(function () {
    var root = document.querySelector(targetSel);
    if (!root) return;
    root.classList.add("vjask");
    // Static template only. Label, placeholder, and Turnstile sitekey are applied via
    // the DOM API below so attribute values are never concatenated into innerHTML.
    root.innerHTML =
      '<form class="vjask-form">' +
      '  <label class="vjask-label" for="vjask-input"></label>' +
      '  <div class="vjask-row">' +
      '    <input id="vjask-input" class="vjask-input" type="text" autocomplete="off" maxlength="2000" />' +
      '    <button class="vjask-btn" type="submit">Ask</button>' +
      "  </div>" +
      (sitekey ? '  <div class="vjask-turnstile-slot"></div>' : "") +
      '  <div class="vjask-answer" aria-live="polite"></div>' +
      '  <ul class="vjask-sources" hidden></ul>' +
      "</form>";

    var form = root.querySelector(".vjask-form");
    var input = root.querySelector(".vjask-input");
    var btn = root.querySelector(".vjask-btn");
    var answer = root.querySelector(".vjask-answer");
    var sources = root.querySelector(".vjask-sources");
    var labelEl = root.querySelector(".vjask-label");
    if (labelEl) labelEl.textContent = label;
    if (input) input.setAttribute("placeholder", placeholder);

    if (sitekey) {
      var slot = root.querySelector(".vjask-turnstile-slot");
      if (slot) {
        var ts = document.createElement("div");
        ts.className = "vjask-turnstile cf-turnstile";
        ts.setAttribute("data-sitekey", sitekey);
        ts.setAttribute("data-size", "flexible");
        slot.replaceWith(ts);
      }
    }

    function turnstileToken() {
      if (!sitekey || !window.turnstile) return "";
      try {
        return window.turnstile.getResponse() || "";
      } catch (e) {
        return "";
      }
    }

    function renderSources(chunks) {
      var seen = {};
      var items = [];
      (chunks || []).forEach(function (c) {
        var key = c && c.item && c.item.key;
        if (key && !seen[key]) {
          seen[key] = true;
          items.push(key);
        }
      });
      if (!items.length) return;
      sources.innerHTML = "<li class='vjask-sources-title'>Sources</li>" +
        items.map(function (k) {
          return "<li>" + k.replace(/[&<>]/g, function (ch) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch];
          }) + "</li>";
        }).join("");
      sources.hidden = false;
    }

    function handleEvent(block) {
      var isChunks = /(^|\n)event:\s*chunks/.test(block);
      var m = block.match(/(^|\n)data:\s?(.*)$/s);
      if (!m) return;
      var payload = m[2].trim();
      if (payload === "[DONE]") return;
      var data;
      try {
        data = JSON.parse(payload);
      } catch (e) {
        return;
      }
      if (isChunks) {
        renderSources(data);
        return;
      }
      var delta = data && data.choices && data.choices[0] && data.choices[0].delta;
      if (delta && delta.content) answer.textContent += delta.content;
    }

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var q = input.value.trim();
      if (!q) return;
      btn.disabled = true;
      answer.textContent = "";
      sources.hidden = true;
      sources.innerHTML = "";

      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, turnstileToken: turnstileToken() }),
      })
        .then(function (res) {
          if (!res.ok || !res.body) {
            return res.json().then(
              function (j) {
                throw new Error(j.error || "error " + res.status);
              },
              function () {
                throw new Error("error " + res.status);
              },
            );
          }
          var reader = res.body.getReader();
          var decoder = new TextDecoder();
          var buf = "";
          function pump() {
            return reader.read().then(function (r) {
              if (r.done) return;
              buf += decoder.decode(r.value, { stream: true });
              var parts = buf.split("\n\n");
              buf = parts.pop();
              parts.forEach(handleEvent);
              return pump();
            });
          }
          return pump();
        })
        .catch(function (err) {
          answer.textContent = "Sorry, something went wrong (" + err.message + ").";
        })
        .finally(function () {
          btn.disabled = false;
          if (sitekey && window.turnstile) {
            try {
              window.turnstile.reset();
            } catch (e) {}
          }
        });
    });
  });
})();
