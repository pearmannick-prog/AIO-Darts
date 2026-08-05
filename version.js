// version.js - shows a rolling version number in the page footer.
//
// /version.json is answered by the server, which works out the running commit
// from the image it was built into or from the platform's env vars - see
// buildVersion() in server/server.js for the order. So this always reflects
// what's actually deployed, with no manual version bumping.
//
// "dev" is a real answer, not a failure: it means nothing told this build
// which commit it is, which is exactly the case when running from a source
// checkout. It's reported as a dev build rather than as the literal string,
// because "build dev" reads like a version number and this isn't one.

const footer = document.getElementById("app-version");

// A deployment that is NOT the production branch says so, loudly, at the top of
// the page. Two near-identical sites is a genuinely easy thing to get wrong:
// the mistakes it prevents are registering an account on the wrong one, filing
// a bug against the wrong one, and - the expensive one - concluding a feature
// is broken in production when you were looking at the test site, or worse,
// that it works when you weren't.
//
// Driven by the branch rather than a hand-set flag, so a test deployment cannot
// forget to identify itself.
function showEnvironmentBanner(branch) {
  if (!branch || branch === "main") return;

  const banner = document.createElement("div");
  banner.className = "env-banner";
  // It used to say accounts here are wiped regularly. That was true before
  // Litestream replicated the database to R2 and restored it on boot, and it
  // stopped being true without anyone updating the sentence - so the app was
  // telling people to distrust data that now survives.
  //
  // The banner's job was never the accounts anyway: it is to stop a test build
  // being mistaken for the live one, which is a statement about WHICH SITE this
  // is and needs no caveat about storage to make its point.
  banner.textContent = `Test deployment · ${branch} · not the live site`;
  document.body.prepend(banner);
}

fetch("./version.json")
  .then((res) => (res.ok ? res.json() : Promise.reject()))
  .then(({ sha, builtAt, branch }) => {
    showEnvironmentBanner(branch);

    if (!sha || sha === "dev") {
      footer.textContent = "AIO Darts · local dev build";
      return;
    }
    const date = builtAt && builtAt !== "unknown" ? builtAt.slice(0, 10) : "";
    footer.textContent =
      `AIO Darts · build ${sha.slice(0, 7)}${date ? ` · ${date}` : ""}` +
      `${branch && branch !== "main" ? ` · ${branch}` : ""}`;
  })
  .catch(() => {
    // No server at all (opened straight off the filesystem).
    footer.textContent = "AIO Darts · local dev build";
  });
