function renderCandidateTracking(reference = "APP-1024") {
  const sanitizedReference = reference.trim() || "APP-1024";
  document.getElementById("candidateStatusBadge").textContent = "En revue RH";
  document.getElementById("candidateTrackingResult").innerHTML = `
    <div class="tracking-summary">
      <strong>${sanitizedReference}</strong>
      <span>Votre candidature est en cours d'examen par le service RH.</span>
    </div>
    <div class="tracking-steps">
      <div class="tracking-step done"><span></span><strong>CV recu</strong><small>Document enregistre</small></div>
      <div class="tracking-step done"><span></span><strong>Analyse effectuee</strong><small>Dossier traite</small></div>
      <div class="tracking-step active"><span></span><strong>En revue RH</strong><small>Verification en cours</small></div>
      <div class="tracking-step"><span></span><strong>Decision</strong><small>Notification apres validation</small></div>
    </div>
  `;
}

document.getElementById("candidateTrackingForm").addEventListener("submit", (event) => {
  event.preventDefault();
  renderCandidateTracking(document.getElementById("candidateReference").value);
});

renderCandidateTracking();
