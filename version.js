// version.js - shows a rolling version number in the page footer.
//
// version.json is generated at Docker build time (see the root Dockerfile)
// with the exact git commit SHA and build timestamp for whatever image is
// currently running - so this always reflects what's actually deployed,
// with no manual version bumping. Running locally via start-aio-darts.bat
// (no Docker) won't have this file at all, so it falls back to a plain
// label.

const footer = document.getElementById("app-version");

fetch("./version.json")
  .then((res) => (res.ok ? res.json() : Promise.reject()))
  .then(({ sha, builtAt }) => {
    const shortSha = sha && sha !== "dev" ? sha.slice(0, 7) : "dev";
    const date = builtAt && builtAt !== "unknown" ? builtAt.slice(0, 10) : "";
    footer.textContent = `AIO Darts · build ${shortSha}${date ? ` · ${date}` : ""}`;
  })
  .catch(() => {
    footer.textContent = "AIO Darts · local dev build";
  });
