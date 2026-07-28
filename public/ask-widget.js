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
  // Optional corpus manifest: maps an R2 object key to a human title, a URL,
  // and a page number, so sources render as citations instead of raw keys.
  var manifestUrl = script.getAttribute("data-manifest") || "";
  var emptyText =
    script.getAttribute("data-empty-text") ||
    "Nothing in the indexed corpus addresses that.";

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


    // ---- corpus manifest -------------------------------------------------
    //
    // Without a manifest the widget can only show the R2 object key, which is
    // an implementation detail ("repo/docs/DEPLOY.md"). With one it can show
    // what a reader actually needs: the document title, a link, and a page.
    //
    // Entries are matched by exact key first, then by SUFFIX. Suffix matching
    // matters because the sync prefixes every object with its repo name, so the
    // key in R2 is "<repo>/<path>" while a corpus producer naturally writes its
    // manifest in terms of its own paths. Suffix matching lets the producer stay
    // ignorant of how the sync namespaces things.
    var manifest = null;
    var manifestIndex = null;

    function indexManifest(data) {
      var entries = [];
      if (Array.isArray(data)) entries = data;
      else if (data && Array.isArray(data.pages)) entries = data.pages;
      else if (data && Array.isArray(data.objects)) entries = data.objects;
      var byKey = {};
      entries.forEach(function (e) {
        if (e && typeof e.key === "string") byKey[e.key] = e;
      });
      return { byKey: byKey, entries: entries };
    }

    function loadManifest() {
      if (!manifestUrl) return Promise.resolve(null);
      if (manifest) return Promise.resolve(manifest);
      return fetch(manifestUrl)
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(function (data) {
          if (!data) return null;
          manifest = data;
          manifestIndex = indexManifest(data);
          return data;
        })
        .catch(function () {
          // A missing or broken manifest must not break answers. Degrade to
          // showing raw keys rather than failing the request.
          return null;
        });
    }

    function lookup(key) {
      if (!manifestIndex) return null;
      if (manifestIndex.byKey[key]) return manifestIndex.byKey[key];
      for (var i = 0; i < manifestIndex.entries.length; i++) {
        var e = manifestIndex.entries[i];
        if (e && typeof e.key === "string" && key.indexOf(e.key) >= 0) {
          var at = key.length - e.key.length;
          if (at >= 0 && key.slice(at) === e.key) return e;
        }
      }
      return null;
    }

    function citationNode(key) {
      var entry = lookup(key);
      var li = document.createElement("li");
      if (!entry) {
        li.textContent = key;
        return li;
      }
      var label = entry.title || key;
      if (entry.url) {
        var a = document.createElement("a");
        a.setAttribute("href", entry.url);
        a.textContent = label;
        li.appendChild(a);
      } else {
        li.appendChild(document.createTextNode(label));
      }
      var bits = [];
      if (entry.page) {
        bits.push("page " + entry.page + (entry.total_pages ? " of " + entry.total_pages : ""));
      }
      if (entry.case_number) bits.push("case " + entry.case_number);
      if (entry.filed_date) bits.push("filed " + entry.filed_date);
      if (bits.length) {
        var span = document.createElement("span");
        span.className = "vjask-source-meta";
        span.textContent = " (" + bits.join(", ") + ")";
        li.appendChild(span);
      }
      return li;
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
      sawSources = true;
      // Built via the DOM API rather than innerHTML: entries come from the
      // corpus manifest, and concatenating them into markup would be an
      // injection path through a data file.
      sources.textContent = "";
      var title = document.createElement("li");
      title.className = "vjask-sources-title";
      title.textContent = "Sources";
      sources.appendChild(title);
      items.forEach(function (k) {
        sources.appendChild(citationNode(k));
      });
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

    var sawSources = false;

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var q = input.value.trim();
      if (!q) return;
      btn.disabled = true;
      answer.textContent = "";
      sources.hidden = true;
      sources.textContent = "";
      sawSources = false;

      loadManifest().then(function () {
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
          // No retrieved sources means nothing in the corpus matched. Say that
          // outright rather than leaving a plausible-looking unsourced answer
          // on screen.
          if (!sawSources && !answer.textContent.trim()) {
            answer.textContent = emptyText;
          }
          btn.disabled = false;
          if (sitekey && window.turnstile) {
            try {
              window.turnstile.reset();
            } catch (e) {}
          }
        });
      });
    });
  });
})();
