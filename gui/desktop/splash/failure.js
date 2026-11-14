// The iOS host reloads this page with ?failure=<sentence>&retry=1 when the engine cannot run.
const params = new URLSearchParams(window.location.search);
const failure = params.get("failure");
if (failure) {
  document.getElementById("status").textContent = failure;
  document.getElementById("retry").hidden = params.get("retry") !== "1";
}
