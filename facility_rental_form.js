(function () {
  function getCheckedValues(form, name) {
    return Array.from(form.querySelectorAll(`input[name="${name}"]:checked`)).map(
      (el) => el.value
    );
  }

  function getRadioValue(form, name) {
    const el = form.querySelector(`input[name="${name}"]:checked`);
    return el ? el.value : "";
  }

  function formatLine(label, value) {
    const safeValue = value && String(value).trim() ? String(value).trim() : "(blank)";
    return `${label}: ${safeValue}`;
  }

  function buildSummary(form) {
    const eventGroup = form.querySelector("#eventGroup")?.value;
    const personResponsible = form.querySelector("#personResponsible")?.value;
    const address = form.querySelector("#address")?.value;
    const phone = form.querySelector("#phone")?.value;
    const purpose = form.querySelector("#purpose")?.value;
    const dateOfUse = form.querySelector("#dateOfUse")?.value;
    const timeFrom = form.querySelector("#timeFrom")?.value;
    const timeTo = form.querySelector("#timeTo")?.value;
    const numberOfPeople = form.querySelector("#numberOfPeople")?.value;

    const facilities = getCheckedValues(form, "facility");
    const avUtilized = getRadioValue(form, "avUtilized");

    const responsibleSignature = form.querySelector("#responsibleSignature")?.value;
    const responsibleSignatureDate = form.querySelector("#responsibleSignatureDate")?.value;
    const churchSignature = form.querySelector("#churchSignature")?.value;
    const churchSignatureDate = form.querySelector("#churchSignatureDate")?.value;

    const notes = form.querySelector("#notes")?.value;

    const lines = [
      "RESERVATION FOR USE OF MT. MORIAH CHURCH FACILITIES (MEMBERS ONLY)",
      "Call: JOHN BURNETT @ 270-210-3809 or WELDON STOKES @ 270-519-9017",
      "",
      formatLine("1. Name(s) of Event/Group", eventGroup),
      formatLine("2. Person responsible", personResponsible),
      formatLine("3. Address", address),
      formatLine("4. Phone Number", phone),
      formatLine("5. Purpose", purpose),
      formatLine("6. Date of Use", dateOfUse),
      formatLine("7. Time (From)", timeFrom),
      formatLine("7. Time (To)", timeTo),
      formatLine("8. Number of People (Approximately)", numberOfPeople),
      formatLine("9. Facility(s) Needed", facilities.length ? facilities.join(", ") : "(none selected)"),
      formatLine("10. A/V Will Be Utilized", avUtilized),
      "",
      "11. Classroom or Nursery Will Not Be Utilized Under \"Any Circumstance\".",
      "",
      "12. Security Deposits - Refund based on condition facility is returned",
      formatLine("Signature of Responsible Person", responsibleSignature),
      formatLine("Date", responsibleSignatureDate),
      formatLine("Signature of Mt. Moriah Responsible Person", churchSignature),
      formatLine("Date", churchSignatureDate),
      "",
      "Notes (optional):",
      notes && String(notes).trim() ? String(notes).trim() : "(blank)",
    ];

    return lines.join("\n");
  }

  function getPayload(form) {
    return {
      eventGroup: form.querySelector("#eventGroup")?.value || "",
      personResponsible: form.querySelector("#personResponsible")?.value || "",
      address: form.querySelector("#address")?.value || "",
      phone: form.querySelector("#phone")?.value || "",
      purpose: form.querySelector("#purpose")?.value || "",
      dateOfUse: form.querySelector("#dateOfUse")?.value || "",
      timeFrom: form.querySelector("#timeFrom")?.value || "",
      timeTo: form.querySelector("#timeTo")?.value || "",
      numberOfPeople: form.querySelector("#numberOfPeople")?.value || "",
      facilities: getCheckedValues(form, "facility"),
      avUtilized: getRadioValue(form, "avUtilized"),
      responsibleSignature: form.querySelector("#responsibleSignature")?.value || "",
      responsibleSignatureDate: form.querySelector("#responsibleSignatureDate")?.value || "",
      churchSignature: form.querySelector("#churchSignature")?.value || "",
      churchSignatureDate: form.querySelector("#churchSignatureDate")?.value || "",
      notes: form.querySelector("#notes")?.value || "",
      contactEmail: form.querySelector("#emailTo")?.value || ""
    };
  }

  function validateRequired(form) {
    const requiredIds = [
      "eventGroup",
      "personResponsible",
      "phone",
      "purpose",
      "dateOfUse",
      "timeFrom",
      "timeTo",
      "responsibleSignature",
      "responsibleSignatureDate",
    ];
    const missing = requiredIds.filter((id) => {
      const el = form.querySelector(`#${id}`);
      return !el || !String(el.value || "").trim();
    });

    const facilities = getCheckedValues(form, "facility");
    if (!facilities.length) missing.push("facility");

    return missing;
  }

  function init() {
    const form = document.getElementById("facilityRentalMembersForm");
    if (!form) return;

    const copyBtn = document.getElementById("copySummaryBtn");

    form.addEventListener("submit", async function (e) {
      e.preventDefault();

      const missing = validateRequired(form);
      if (missing.length) {
        const labels = {
          eventGroup: "Name(s) of Event/Group",
          personResponsible: "Person responsible",
          phone: "Phone Number",
          purpose: "Purpose",
          dateOfUse: "Date of Use",
          timeFrom: "Time (From)",
          timeTo: "Time (To)",
          responsibleSignature: "Signature of Responsible Person",
          responsibleSignatureDate: "Signature Date",
          facility: "Facility(s) Needed",
        };
        alert(
          "Please complete required fields: " +
            missing
              .map((k) => labels[k] || k)
              .join(", ")
        );
        return;
      }

      const to = document.getElementById("emailTo")?.value || "mtmoriahmbc@comcast.net";
      const subject = "Facility Reservation Request (Members Only)";
      const body = buildSummary(form);
      const payload = {
        audience: 'member',
        form: getPayload(form)
      };

      try {
        const res = await fetch('/api/public/facility-rental-request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error('submit failed');
        alert('Your facility rental request has been sent.');
        form.reset();
      } catch {
        const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(
          body
        )}`;
        window.location.href = mailto;
      }
    });

    if (copyBtn) {
      copyBtn.addEventListener("click", async function () {
        const summary = buildSummary(form);
        try {
          await navigator.clipboard.writeText(summary);
          alert("Copied request summary to clipboard.");
        } catch (err) {
          // Fallback: prompt the text for manual copy
          window.prompt("Copy the request summary:", summary);
        }
      });
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
