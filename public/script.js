import { db, auth, storage } from "./firebase.js";
import {
  collection,
  addDoc,
  getDocs,
  getDoc,
  updateDoc,
  doc,
  query,
  where,
  Timestamp,
  increment,
  onSnapshot,
  arrayUnion
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import {
  calculateResolutionScore,
  calculateWardPerformance,
  calculateCategoryMetrics,
  uploadResolutionEvidence,
  checkRecidivism,
  getDistanceFromLatLonInM,
  SEVERITY_MAP,
  SLA_DAYS,
  getTimestampMillis
} from "./resolution-engine.js";

console.log("CivicWatch Core & Advanced Engine loaded");

/* ---------- GLOBAL IN-MEMORY CACHE OF COMPLAINTS ---------- */
let allComplaintsCache = [];
let selectedEvidenceFile = null;

/* ================= 1. REPORT ISSUE (WITH DUPLICATE & RECIDIVISM) ================= */
const form = document.getElementById("reportForm");
const message = document.getElementById("message");

if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const issueType = document.getElementById("issueType").value;
    const ward = document.getElementById("ward").value;
    const description = document.getElementById("description").value.trim();
    const imageUrl = document.getElementById("imageUrl").value.trim();

    const submitComplaint = async (latitude = null, longitude = null) => {
      try {
        let duplicateFound = false;
        let duplicateId = null;

        if (latitude !== null && longitude !== null) {
          // Check for duplicate issue within 50m radius in the same ward & category
          const q = query(
            collection(db, "Complaints"),
            where("issueType", "==", issueType),
            where("ward", "==", ward)
          );
          const querySnapshot = await getDocs(q);

          querySnapshot.forEach((docSnap) => {
            if (duplicateFound) return;
            const data = docSnap.data();
            if (data.latitude && data.longitude) {
              const dist = getDistanceFromLatLonInM(latitude, longitude, data.latitude, data.longitude);
              if (dist <= 50) {
                duplicateFound = true;
                duplicateId = docSnap.id;
              }
            }
          });
        }

        const now = Timestamp.now();
        const slaDays = SLA_DAYS[issueType] || 7;
        const slaDeadline = Timestamp.fromMillis(now.toMillis() + (slaDays * 86400000));

        if (duplicateFound) {
          // Update existing complaint counter & timeline
          await updateDoc(doc(db, "Complaints", duplicateId), {
            reports: increment(1),
            timeline: arrayUnion({
              stage: "Reported",
              timestamp: now,
              actor: "Citizen",
              note: "Additional citizen report registered in area"
            })
          });
          message.innerText = "Your report was added to an existing civic issue in this area!";
        } else {
          // Check for Infrastructure Recidivism (Defect at same spot within 25m closed in last 60d)
          const recidivismCheck = checkRecidivism(latitude, longitude, issueType, allComplaintsCache);
          const isRecidivist = recidivismCheck.isRecidivist;
          const recidivismDetails = isRecidivist ? recidivismCheck : null;

          const initialNote = isRecidivist
            ? `Issue lodged (⚠️ Recurrent defect within 25m of previous repair ${recidivismCheck.daysSinceResolution}d ago)`
            : "Issue lodged by citizen";

          // New issue -> create document with complete schema
          await addDoc(collection(db, "Complaints"), {
            issueType,
            ward,
            description,
            imageUrl,
            latitude,
            longitude,
            status: "Reported",
            reports: 1,
            createdAt: now,
            slaDeadline,
            isRecidivist,
            recidivismDetails,
            verificationsCount: 0,
            rejectionsCount: 0,
            verifiedBy: [],
            timeline: [
              {
                stage: "Reported",
                timestamp: now,
                actor: "Citizen",
                note: initialNote
              }
            ]
          });

          if (isRecidivist) {
            message.innerText = "⚠️ Issue reported! Note: System identified a recurrent defect at this location.";
          } else {
            message.innerText = "Issue reported successfully!";
          }
        }

        message.style.color = "green";
        form.reset();
      } catch (err) {
        console.error("Submission error:", err);
        message.innerText = "Error submitting issue. Please try again.";
        message.style.color = "red";
      }
    };

    if (!navigator.geolocation) {
      await submitComplaint();
      return;
    }

    message.innerText = "Fetching location & checking area history...";
    message.style.color = "blue";

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        await submitComplaint(position.coords.latitude, position.coords.longitude);
      },
      async (error) => {
        console.warn("Geolocation warning:", error.message);
        await submitComplaint();
      },
      { timeout: 8000 }
    );
  });
}

/* ================= 2. PUBLIC ISSUES LIST & TRANSPARENCY ================= */
async function loadIssues() {
  const list = document.getElementById("issuesGrid");
  if (!list) return;

  try {
    const statusFilter = document.getElementById("statusFilter")?.value || "ALL";
    const wardFilter = document.getElementById("wardFilter")?.value || "ALL";

    let items = [...allComplaintsCache];

    // Filter by status
    if (statusFilter !== "ALL") {
      if (statusFilter === "Resolution Submitted") {
        items = items.filter(i => i.status === "Resolution Submitted" || i.status === "Under Verification");
      } else {
        items = items.filter(i => i.status === statusFilter);
      }
    }

    // Filter by ward
    if (wardFilter !== "ALL") {
      items = items.filter(i => i.ward === wardFilter);
    }

    // Compute priority, SLA, & resolution score
    const now = Date.now();
    const issuesArray = items.map((i) => {
      const reports = i.reports || 1;
      const createdMillis = getTimestampMillis(i.createdAt) || now;
      const days = Math.max(0, Math.floor((now - createdMillis) / 86400000));
      const severity = SEVERITY_MAP[i.issueType] || 1;
      const priority = (reports * 2) + (days * 3) + severity;
      const scoreData = calculateResolutionScore(i);

      // SLA Countdown calculation
      const slaDays = SLA_DAYS[i.issueType] || 7;
      const deadlineMillis = getTimestampMillis(i.slaDeadline) || (createdMillis + (slaDays * 86400000));
      const isResolved = i.status === "Resolved";
      let slaBadgeHtml = "";

      if (isResolved) {
        slaBadgeHtml = `<span class="sla-badge sla-badge-ok">✓ Resolved</span>`;
      } else if (now > deadlineMillis) {
        const overdueDays = Math.max(1, Math.floor((now - deadlineMillis) / 86400000));
        slaBadgeHtml = `<span class="sla-badge sla-badge-overdue">⚠ Overdue (${overdueDays}d)</span>`;
      } else {
        const remainingDays = Math.max(1, Math.ceil((deadlineMillis - now) / 86400000));
        slaBadgeHtml = `<span class="sla-badge sla-badge-ok">SLA: ${remainingDays}d left</span>`;
      }

      return {
        ...i,
        days,
        priority,
        scoreData,
        slaBadgeHtml
      };
    });

    // Sort by priority descending
    issuesArray.sort((a, b) => b.priority - a.priority);

    list.innerHTML = "";

    if (issuesArray.length === 0) {
      list.innerHTML = "<p style='grid-column: 1/-1; text-align: center; color: #64748b; padding: 2rem;'>No civic issues match your filter criteria.</p>";
      return;
    }

    issuesArray.forEach((i) => {
      let priorityLabel = "LOW";
      let priorityClass = "low";
      if (i.priority >= 75) {
        priorityLabel = "CRITICAL";
        priorityClass = "critical";
      } else if (i.priority >= 35) {
        priorityLabel = "HIGH";
        priorityClass = "high";
      } else if (i.priority >= 15) {
        priorityLabel = "MEDIUM";
        priorityClass = "medium";
      }

      const statusKey = (i.status || "Reported").toLowerCase().replace(/\s+/g, "");
      const hasProofOrSubmitted = i.status === "Resolved" || i.status === "Resolution Submitted" || i.status === "Under Verification" || i.resolution?.evidenceUrl;

      // PRISTINE ORIGINAL CARD LAYOUT WITH MODULAR EXTENSIONS
      list.innerHTML += `
        <div class="issue-card">
          ${i.imageUrl ? `<img src="${i.imageUrl}" alt="${i.issueType}" onerror="this.style.display='none'">` : ""}
          <h3>${i.issueType}</h3>
          <p><strong>Ward:</strong> ${i.ward}</p>
          <p>Status:
            <span class="status status-${statusKey}">
              ${i.status}
            </span>
            ${i.isRecidivist ? `<span class="recidivist-badge" style="margin-left: 4px;">⚠️ Recurrent</span>` : ""}
          </p>
          <p>Pending for ${i.days} ${i.days === 1 ? 'day' : 'days'}</p>
          <p>${i.reports || 1} ${(i.reports || 1) === 1 ? 'person reported this' : 'people reported this'}</p>

          <div style="margin: 1.2rem 1.2rem 0.6rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
              <span class="priority-level priority-${priorityClass}">${priorityLabel} PRIORITY</span>
              ${i.slaBadgeHtml}
            </div>
            <div class="priority-bar-container">
              <div class="priority-bar-fill priority-bar-${priorityClass}"></div>
            </div>
          </div>

          <div class="issue-card-footer">
            <button type="button" class="btn btn-sm btn-info btn-full" onclick="openPublicProofModal('${i.id}')">
              ${hasProofOrSubmitted ? "🔍 View Proof & Timeline" : "📋 View Timeline & Details"}
            </button>
          </div>
        </div>
      `;
    });
  } catch (err) {
    console.error("Error loading issues:", err);
  }
}

// Bind filter changes
document.getElementById("statusFilter")?.addEventListener("change", loadIssues);
document.getElementById("wardFilter")?.addEventListener("change", loadIssues);

/* ================= 3. SPOT CHECK PROTOCOL (CONFIRM / DISPUTE) ================= */
window.performSpotCheck = async (complaintId, action) => {
  const item = allComplaintsCache.find(c => c.id === complaintId);
  if (!item) return;

  const user = auth.currentUser;
  const actorId = user ? user.uid : `citizen_${Math.random().toString(36).substring(2, 8)}`;
  const now = Timestamp.now();

  try {
    if (action === "CONFIRM") {
      await updateDoc(doc(db, "Complaints", complaintId), {
        verificationsCount: increment(1),
        verifiedBy: arrayUnion(actorId),
        timeline: arrayUnion({
          stage: "Spot Checked",
          timestamp: now,
          actor: "Citizen",
          note: "Ground fix confirmed on-site by community member"
        })
      });

      alert("✓ Thank you! Your ground verification spot check has been recorded.");
      openPublicProofModal(complaintId);
    } else if (action === "DISPUTE") {
      const reason = prompt("Please provide a brief reason for disputing this fix (e.g. debris not cleared, road still broken):");
      if (reason === null) return; // User cancelled

      const newRejectionsCount = (item.rejectionsCount || 0) + 1;
      const shouldReopen = newRejectionsCount >= 2 || item.status === "Resolved";

      const updateData = {
        rejectionsCount: increment(1),
        timeline: arrayUnion({
          stage: shouldReopen ? "In Progress" : "Disputed",
          timestamp: now,
          actor: "Citizen",
          note: `Ground dispute registered: ${reason || "Fix incomplete"}`
        })
      };

      if (shouldReopen) {
        updateData.status = "In Progress";
        updateData["resolution.status"] = "Rejected";
        updateData["resolution.rejectionReason"] = `Community spot check dispute: ${reason || "Incomplete fix"}`;
      }

      await updateDoc(doc(db, "Complaints", complaintId), updateData);

      if (shouldReopen) {
        alert("⚠️ Fix disputed! Due to community dispute, this issue has been automatically flagged and returned to 'In Progress' for contractor rework.");
      } else {
        alert("Dispute registered. If another citizen disputes, this issue will automatically be returned for rework.");
      }
      openPublicProofModal(complaintId);
    }
  } catch (err) {
    console.error("Spot check error:", err);
    alert("Could not submit spot check: " + err.message);
  }
};

/* ================= 4. ADMIN PANEL & VERIFICATION QUEUE ================= */
async function loadAdmin() {
  const activeTableBody = document.getElementById("adminTableBody");
  if (!activeTableBody) return;

  try {
    const complaints = [...allComplaintsCache];

    // Compute KPI Summary Metrics
    const totalCount = complaints.length;
    let activeCount = 0;
    let pendingVerificationCount = 0;
    let resolvedCount = 0;
    let sumResolvedScore = 0;

    complaints.forEach((i) => {
      const st = i.status || "Reported";
      if (st === "Resolved") {
        resolvedCount += 1;
        const scoreCalc = calculateResolutionScore(i);
        sumResolvedScore += scoreCalc.score;
      } else if (st === "Resolution Submitted" || st === "Under Verification" || i.resolution?.status === "Submitted") {
        pendingVerificationCount += 1;
      } else {
        activeCount += 1;
      }
    });

    const avgResScore = resolvedCount > 0 ? Math.round(sumResolvedScore / resolvedCount) : 0;
    const resRate = totalCount > 0 ? Math.round((resolvedCount / totalCount) * 100) : 0;

    // Update KPI DOM
    const kpiTotal = document.getElementById("kpiTotalComplaints");
    const kpiActive = document.getElementById("kpiActiveComplaints");
    const kpiPending = document.getElementById("kpiPendingVerification");
    const kpiResolved = document.getElementById("kpiResolvedComplaints");
    const kpiAvgScore = document.getElementById("kpiAvgResolutionScore");
    const kpiRate = document.getElementById("kpiResolutionRate");
    const queueBadge = document.getElementById("queueCountBadge");

    if (kpiTotal) kpiTotal.innerText = totalCount;
    if (kpiActive) kpiActive.innerText = activeCount;
    if (kpiPending) kpiPending.innerText = pendingVerificationCount;
    if (kpiResolved) kpiResolved.innerText = resolvedCount;
    if (kpiAvgScore) kpiAvgScore.innerHTML = `${avgResScore}<span style="font-size: 1rem; font-weight: normal; color: #64748b;">/100</span>`;
    if (kpiRate) kpiRate.innerText = `${resRate}%`;
    if (queueBadge) queueBadge.innerText = pendingVerificationCount;

    // 1. Populate Active Complaints Table
    activeTableBody.innerHTML = "";
    if (complaints.length === 0) {
      activeTableBody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#64748b; padding:2rem;">No complaints registered.</td></tr>`;
    } else {
      complaints.forEach((i) => {
        const createdDate = i.createdAt ? new Date(getTimestampMillis(i.createdAt)).toLocaleDateString() : "-";
        const scoreData = calculateResolutionScore(i);
        const slaDays = SLA_DAYS[i.issueType] || 7;
        const statusKey = (i.status || "Reported").toLowerCase().replace(/\s+/g, "");

        let actionHtml = "";
        const st = i.status || "Reported";

        if (st === "Reported") {
          actionHtml = `
            <div class="action-btn-group">
              <button class="btn-sm btn-info" onclick="updateLifecycleStage('${i.id}', 'Acknowledged')">Acknowledge</button>
            </div>
          `;
        } else if (st === "Acknowledged") {
          actionHtml = `
            <div class="action-btn-group">
              <button class="btn-sm btn-warning" onclick="updateLifecycleStage('${i.id}', 'In Progress')">Start Work</button>
            </div>
          `;
        } else if (st === "In Progress" || st === "Rejected") {
          actionHtml = `
            <div class="action-btn-group">
              <button class="btn-sm btn-purple" onclick="openResolutionModal('${i.id}')">Submit Resolution</button>
            </div>
          `;
        } else if (st === "Resolution Submitted" || st === "Under Verification") {
          actionHtml = `
            <div class="action-btn-group">
              <button class="btn-sm btn-warning" onclick="openVerificationModal('${i.id}')">Review & Verify</button>
            </div>
          `;
        } else if (st === "Resolved") {
          actionHtml = `
            <div class="action-btn-group">
              <button class="btn-sm btn-info" onclick="openPublicProofModal('${i.id}')">View Proof</button>
              <button class="btn-sm btn-danger" onclick="reopenComplaint('${i.id}')">Reopen</button>
            </div>
          `;
        } else if (st === "Reopened") {
          actionHtml = `
            <div class="action-btn-group">
              <button class="btn-sm btn-warning" onclick="updateLifecycleStage('${i.id}', 'In Progress')">Restart Work</button>
            </div>
          `;
        }

        activeTableBody.innerHTML += `
          <tr>
            <td>
              ${i.imageUrl
                ? `<img src="${i.imageUrl}" class="thumb-img" alt="Thumbnail" onerror="this.src='https://via.placeholder.com/60?text=No+Img'">`
                : `<span style="color:#94a3b8; font-size:0.8rem;">No photo</span>`}
            </td>
            <td>
              <strong>${i.issueType}</strong>
              ${i.isRecidivist ? `<br><span class="recidivist-badge">⚠️ Recurrent</span>` : ""}
            </td>
            <td>${i.ward}</td>
            <td>
              <div style="font-size: 0.85rem;">${createdDate}</div>
              <div style="font-size: 0.75rem; color: #64748b;">SLA: ${slaDays}d</div>
            </td>
            <td>
              <span style="font-size: 0.8rem; font-weight: 600; color: #0f172a;">${i.reports || 1} reps</span>
            </td>
            <td>
              <span class="badge status-${statusKey}">
                ${i.status}
              </span>
              ${i.rejectionsCount > 0 ? `<br><span style="color:#dc2626; font-size:0.72rem; font-weight:700;">⚠ ${i.rejectionsCount} Disputed</span>` : ""}
            </td>
            <td>
              <strong style="color: ${scoreData.score >= 75 ? '#16a34a' : scoreData.score >= 50 ? '#d97706' : '#64748b'};">
                ${scoreData.score}/100
              </strong>
            </td>
            <td>${actionHtml}</td>
          </tr>
        `;
      });
    }

    // 2. Populate Verification Queue Table
    const queueBody = document.getElementById("verificationQueueTableBody");
    if (queueBody) {
      const pendingItems = complaints.filter(
        i => i.status === "Resolution Submitted" || i.status === "Under Verification" || i.resolution?.status === "Submitted"
      );

      queueBody.innerHTML = "";
      if (pendingItems.length === 0) {
        queueBody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#64748b; padding:2rem;">No pending resolutions in the queue. All submissions verified!</td></tr>`;
      } else {
        pendingItems.forEach((i) => {
          const scoreData = calculateResolutionScore(i);
          const evidenceTypeLabel = i.resolution?.evidenceType === "firebase_storage"
            ? `<span style="color:#059669; font-weight:700;">✓ Official Storage</span>`
            : `<span style="color:#d97706;">External Link</span>`;

          queueBody.innerHTML += `
            <tr>
              <td>
                ${i.imageUrl
                  ? `<img src="${i.imageUrl}" class="thumb-img" alt="Before" onerror="this.src='https://via.placeholder.com/60?text=No+Img'">`
                  : `<span style="color:#94a3b8; font-size:0.8rem;">None</span>`}
              </td>
              <td>
                ${i.resolution?.evidenceUrl
                  ? `<img src="${i.resolution.evidenceUrl}" class="thumb-img" alt="After" onerror="this.src='https://via.placeholder.com/60?text=No+Img'">`
                  : `<span style="color:#dc2626; font-size:0.8rem;">Missing photo</span>`}
              </td>
              <td>
                <strong>${i.issueType}</strong><br>
                <span style="font-size:0.8rem; color:#64748b;">${i.ward}</span>
              </td>
              <td>
                <div style="font-size:0.85rem; max-width:200px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${i.resolution?.description || ''}">
                  ${i.resolution?.description || "-"}
                </div>
                ${i.verificationsCount > 0 ? `<div style="font-size:0.75rem; color:#16a34a; font-weight:600;">✓ ${i.verificationsCount} Citizen Audits</div>` : ""}
              </td>
              <td>${evidenceTypeLabel}</td>
              <td><strong>${scoreData.score}/100</strong></td>
              <td>
                <button class="btn-sm btn-success" onclick="openVerificationModal('${i.id}')">Inspect & Verify</button>
              </td>
            </tr>
          `;
        });
      }
    }

    // 3. Populate Ward Rankings Table in Admin
    const wardRankingsBody = document.getElementById("adminWardRankingsBody");
    if (wardRankingsBody) {
      const wardResults = calculateWardPerformance(complaints);
      wardRankingsBody.innerHTML = "";

      if (wardResults.length === 0) {
        wardRankingsBody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:#64748b; padding:2rem;">No ward data available.</td></tr>`;
      } else {
        wardResults.forEach((w) => {
          wardRankingsBody.innerHTML += `
            <tr>
              <td><strong>#${w.rank}</strong></td>
              <td><strong>${w.ward}</strong></td>
              <td>
                <span style="font-size: 1.1rem; font-weight: 800; color: #0f172a;">${w.score}</span>
                <span style="font-size: 0.8rem; color: #64748b;">/100</span>
                ${w.penalties.totalPenalties > 0 ? `<span class="penalty-pill">-${w.penalties.totalPenalties} penalty</span>` : ""}
              </td>
              <td><span class="grade-badge ${w.gradeClass}">${w.grade}</span></td>
              <td>
                ${w.totalIssues} issues
                ${w.isLowSample ? `<br><span class="low-sample-badge">Low Sample</span>` : ""}
              </td>
              <td>${w.resolutionRate}% (${w.resolvedCount}/${w.totalIssues})</td>
              <td>${w.avgResolutionDays === "-" ? "-" : w.avgResolutionDays + " days"}</td>
              <td>${w.verifiedRate}%</td>
              <td>${w.metrics.evidenceRate}%</td>
            </tr>
          `;
        });
      }
    }

    // 4. Populate Category Performance Matrix
    const catMatrixBody = document.getElementById("adminCategoryMatrixBody");
    if (catMatrixBody) {
      const catResults = calculateCategoryMetrics(complaints);
      catMatrixBody.innerHTML = "";

      if (catResults.length === 0) {
        catMatrixBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#64748b; padding:2rem;">No category data available.</td></tr>`;
      } else {
        catResults.forEach((c) => {
          catMatrixBody.innerHTML += `
            <tr>
              <td><strong>${c.category}</strong></td>
              <td>${c.total}</td>
              <td>${c.resolved}</td>
              <td>
                <strong>${c.resolutionRate}%</strong>
              </td>
              <td>${c.avgScore}/100</td>
              <td>${c.avgTime}</td>
            </tr>
          `;
        });
      }
    }

  } catch (err) {
    console.error("Error loading admin panel:", err);
  }
}

/* ================= 5. WARD PERFORMANCE (HOMEPAGE & SIDEBAR) ================= */
async function wardDashboard() {
  const div = document.getElementById("wardDashboard");
  if (!div) return;

  try {
    const wardResults = calculateWardPerformance(allComplaintsCache);
    div.innerHTML = "";

    if (wardResults.length === 0) {
      div.innerHTML = "<p style='color: #64748b; font-size: 0.9rem;'>No ward performance data available yet.</p>";
      return;
    }

    // Check if we are rendering inside the sidebar (issues.html) or on homepage (index.html)
    const isInsideSidebar = !!div.closest(".sidebar");

    if (isInsideSidebar) {
      // Compact sidebar widget
      wardResults.forEach((w) => {
        div.innerHTML += `
          <div class="ward-stat-item">
            <div class="ward-header">
              <span>${w.ward} (Rank #${w.rank})</span>
              <span><strong>${w.score}/100</strong></span>
            </div>

            <div class="progress-bar">
              <div class="progress-fill" style="width: ${w.resolutionRate}%;"></div>
            </div>

            <div style="display: flex; justify-content: space-between; font-size: 0.75rem; color: #64748b; margin-top: 4px;">
              <span>Resolution: ${w.resolutionRate}%</span>
              <span>${w.grade}</span>
            </div>

            ${w.isLowSample ? `<span class="low-sample-badge">Low Sample (${w.totalIssues} cases)</span>` : ""}
          </div>
        `;
      });
    } else {
      // Homepage overview grid
      let gridHtml = `<div class="ward-grid-overview">`;
      wardResults.forEach((w) => {
        gridHtml += `
          <div class="ward-overview-card">
            <div class="ward-header">
              <div>
                <span style="font-size: 1.1rem; font-weight: 700; color: #0f172a;">${w.ward}</span>
                <span style="font-size: 0.78rem; color: #64748b; margin-left: 6px;">Rank #${w.rank}</span>
              </div>
              <span class="grade-badge ${w.gradeClass}">${w.grade} (${w.score}/100)</span>
            </div>

            <div style="display: flex; justify-content: space-between; font-size: 0.85rem; color: #64748b; margin: 0.8rem 0 0.4rem;">
              <span>Resolution Rate</span>
              <span><strong>${w.resolutionRate}%</strong> (${w.resolvedCount}/${w.totalIssues})</span>
            </div>

            <div class="progress-bar" style="height: 10px;">
              <div class="progress-fill" style="width: ${w.resolutionRate}%;"></div>
            </div>

            <div style="display: flex; justify-content: space-between; font-size: 0.78rem; color: #64748b; margin-top: 8px;">
              <span>Avg Resolution: <strong>${w.avgResolutionDays === "-" ? "-" : w.avgResolutionDays + " days"}</strong></span>
              <span>Verified: <strong>${w.verifiedRate}%</strong></span>
            </div>

            ${w.isLowSample ? `<div class="low-sample-badge" style="margin-top: 8px;">⚠ Low Sample Size (${w.totalIssues} cases)</div>` : ""}
          </div>
        `;
      });
      gridHtml += `</div>`;
      div.innerHTML = gridHtml;
    }
  } catch (err) {
    console.error("Error loading ward dashboard:", err);
  }
}

/* ================= 6. ADMIN LIFECYCLE CONTROLLERS ================= */

// Transition stage (e.g. Reported -> Acknowledged -> In Progress)
window.updateLifecycleStage = async (id, nextStage) => {
  try {
    const now = Timestamp.now();
    const note = nextStage === "Acknowledged"
      ? "Complaint acknowledged and queued for maintenance"
      : nextStage === "In Progress"
      ? "Field team dispatched and physical repair work commenced"
      : `Status updated to ${nextStage}`;

    await updateDoc(doc(db, "Complaints", id), {
      status: nextStage,
      timeline: arrayUnion({
        stage: nextStage,
        timestamp: now,
        actor: "Municipal Officer",
        note
      })
    });
  } catch (error) {
    console.error("Error updating stage:", error);
    alert("Could not update stage. Please check connection.");
  }
};

// Reopen a resolved issue
window.reopenComplaint = async (id) => {
  const confirmReopen = confirm("Are you sure you want to reopen this resolved complaint? This will apply a penalty to the resolution score.");
  if (!confirmReopen) return;

  try {
    const now = Timestamp.now();
    await updateDoc(doc(db, "Complaints", id), {
      status: "Reopened",
      "resolution.status": "Reopened",
      "resolution.reopenedAt": now,
      timeline: arrayUnion({
        stage: "Reopened",
        timestamp: now,
        actor: "Municipal Officer",
        note: "Issue reopened for additional remedial work"
      })
    });
  } catch (err) {
    console.error("Error reopening complaint:", err);
    alert("Failed to reopen issue.");
  }
};

/* ================= 7. RESOLUTION EVIDENCE SUBMISSION MODAL ================= */

window.openResolutionModal = (complaintId) => {
  const item = allComplaintsCache.find(c => c.id === complaintId);
  if (!item) return;

  document.getElementById("resModalComplaintId").value = complaintId;
  document.getElementById("resModalIssueType").innerText = item.issueType || "-";
  document.getElementById("resModalWard").innerText = item.ward || "-";
  document.getElementById("resModalDescription").innerText = item.description || "-";

  // Reset inputs
  document.getElementById("resolutionFileInput").value = "";
  document.getElementById("resolutionUrlInput").value = "";
  document.getElementById("resolutionDescriptionInput").value = "";
  document.getElementById("fileSelectedInfo").style.display = "none";
  document.getElementById("fileSelectedInfo").innerText = "";
  document.getElementById("uploadProgressContainer").style.display = "none";
  document.getElementById("resModalError").style.display = "none";
  selectedEvidenceFile = null;

  document.getElementById("resolutionModal").classList.add("open");
};

window.closeResolutionModal = () => {
  document.getElementById("resolutionModal")?.classList.remove("open");
};

// File selection listener
document.getElementById("resolutionFileInput")?.addEventListener("change", (e) => {
  const file = e.target.files[0];
  const infoEl = document.getElementById("fileSelectedInfo");
  if (file) {
    selectedEvidenceFile = file;
    infoEl.innerText = `Selected: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`;
    infoEl.style.display = "block";
  } else {
    selectedEvidenceFile = null;
    infoEl.style.display = "none";
  }
});

// Submit Resolution Button Handler
document.getElementById("submitResolutionBtn")?.addEventListener("click", async () => {
  const id = document.getElementById("resModalComplaintId").value;
  const desc = document.getElementById("resolutionDescriptionInput").value.trim();
  const urlFallback = document.getElementById("resolutionUrlInput").value.trim();
  const errorEl = document.getElementById("resModalError");
  const submitBtn = document.getElementById("submitResolutionBtn");

  errorEl.style.display = "none";

  if (!desc) {
    errorEl.innerText = "Please provide a description of the completed work.";
    errorEl.style.display = "block";
    return;
  }

  if (!selectedEvidenceFile && !urlFallback) {
    errorEl.innerText = "Please attach an after-resolution photograph (Storage upload or image link).";
    errorEl.style.display = "block";
    return;
  }

  try {
    submitBtn.disabled = true;
    submitBtn.innerText = "Processing...";

    let evidenceUrl = urlFallback;
    let evidenceType = "external_url";

    if (selectedEvidenceFile) {
      const progressContainer = document.getElementById("uploadProgressContainer");
      const progressFill = document.getElementById("uploadProgressFill");
      const progressStatus = document.getElementById("uploadProgressStatus");

      progressContainer.style.display = "block";

      const uploadResult = await uploadResolutionEvidence(
        selectedEvidenceFile,
        id,
        (percent) => {
          progressFill.style.width = `${percent}%`;
          progressStatus.innerText = `Uploading to Firebase Storage: ${percent}%`;
        }
      );

      evidenceUrl = uploadResult.downloadUrl;
      evidenceType = uploadResult.evidenceType;
    }

    const now = Timestamp.now();

    await updateDoc(doc(db, "Complaints", id), {
      status: "Resolution Submitted",
      resolution: {
        status: "Submitted",
        description: desc,
        evidenceUrl: evidenceUrl,
        evidenceType: evidenceType,
        submittedAt: now,
        verifiedAt: null,
        rejectionReason: null,
        reopenedAt: null
      },
      timeline: arrayUnion({
        stage: "Resolution Submitted",
        timestamp: now,
        actor: "Municipal Officer",
        note: "Resolution evidence and completion report submitted for verification"
      })
    });

    closeResolutionModal();
  } catch (err) {
    console.error("Resolution submit error:", err);
    errorEl.innerText = err.message || "Failed to submit resolution evidence.";
    errorEl.style.display = "block";
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerText = "Submit for Verification";
  }
});

/* ================= 8. VERIFICATION MODAL & DECISIONS ================= */

window.openVerificationModal = (complaintId) => {
  const item = allComplaintsCache.find(c => c.id === complaintId);
  if (!item) return;

  document.getElementById("verifyModalComplaintId").value = complaintId;

  // Before image
  const beforeCont = document.getElementById("verifyModalBeforeContainer");
  if (item.imageUrl) {
    beforeCont.innerHTML = `<img src="${item.imageUrl}" class="proof-img" alt="Before" onerror="this.outerHTML='<div class=proof-placeholder>Image unavailable</div>'">`;
  } else {
    beforeCont.innerHTML = `<div class="proof-placeholder">No citizen photo attached</div>`;
  }

  // After image
  const afterCont = document.getElementById("verifyModalAfterContainer");
  if (item.resolution?.evidenceUrl) {
    afterCont.innerHTML = `<img src="${item.resolution.evidenceUrl}" class="proof-img" alt="After" onerror="this.outerHTML='<div class=proof-placeholder>Image unavailable</div>'">`;
  } else {
    afterCont.innerHTML = `<div class="proof-placeholder" style="color:#dc2626;">No resolution evidence uploaded</div>`;
  }

  // Description & Metadata
  document.getElementById("verifyModalDescription").innerText = item.resolution?.description || "No description provided.";
  
  const evTypeLabel = item.resolution?.evidenceType === "firebase_storage"
    ? "Official Firebase Storage Evidence"
    : "External Link / Fallback";
  
  document.getElementById("verifyModalMeta").innerText = `Evidence Type: ${evTypeLabel} | Submitted: ${item.resolution?.submittedAt ? new Date(getTimestampMillis(item.resolution.submittedAt)).toLocaleString() : "Recently"}`;

  // Score preview
  const scoreCalc = calculateResolutionScore(item);
  document.getElementById("verifyModalScorePreview").innerHTML = `
    <div style="background: #e0f2fe; padding: 0.8rem; border-radius: 8px; font-size: 0.85rem;">
      <strong>Projected Resolution Score: ${scoreCalc.score}/100</strong>
      <div style="font-size: 0.78rem; color: #0369a1; margin-top: 4px;">
        Verification: ${scoreCalc.breakdown.verification}/40 | Timeliness: ${scoreCalc.breakdown.timeliness}/30 | Evidence: ${scoreCalc.breakdown.evidence}/30
      </div>
    </div>
  `;

  // Reset rejection input
  document.getElementById("rejectionReasonBox").style.display = "none";
  document.getElementById("rejectionReasonInput").value = "";
  document.getElementById("verifyModalError").style.display = "none";

  document.getElementById("verificationModal").classList.add("open");
};

window.closeVerificationModal = () => {
  document.getElementById("verificationModal")?.classList.remove("open");
};

// Approve Resolution (Verify)
document.getElementById("verifyApproveBtn")?.addEventListener("click", async () => {
  const id = document.getElementById("verifyModalComplaintId").value;
  const item = allComplaintsCache.find(c => c.id === id);
  const approveBtn = document.getElementById("verifyApproveBtn");

  try {
    approveBtn.disabled = true;
    approveBtn.innerText = "Verifying...";

    const now = Timestamp.now();
    const updatedItem = {
      ...item,
      status: "Resolved",
      resolution: {
        ...(item?.resolution || {}),
        status: "Verified",
        verifiedAt: now
      }
    };

    const finalScore = calculateResolutionScore(updatedItem).score;

    await updateDoc(doc(db, "Complaints", id), {
      status: "Resolved",
      "resolution.status": "Verified",
      "resolution.verifiedAt": now,
      "resolution.resolutionScore": finalScore,
      timeline: arrayUnion({
        stage: "Resolved",
        timestamp: now,
        actor: "Municipal Officer",
        note: `Resolution certified and officially resolved (Quality Score: ${finalScore}/100)`
      })
    });

    closeVerificationModal();
  } catch (err) {
    console.error("Verification approve error:", err);
    alert("Failed to verify resolution: " + err.message);
  } finally {
    approveBtn.disabled = false;
    approveBtn.innerText = "Verify & Resolve";
  }
});

// Reject Resolution (Request Rework)
document.getElementById("verifyRejectBtn")?.addEventListener("click", async () => {
  const id = document.getElementById("verifyModalComplaintId").value;
  const rejectionBox = document.getElementById("rejectionReasonBox");
  const reasonInput = document.getElementById("rejectionReasonInput");
  const errorEl = document.getElementById("verifyModalError");

  if (rejectionBox.style.display === "none") {
    rejectionBox.style.display = "block";
    reasonInput.focus();
    return;
  }

  const reason = reasonInput.value.trim();
  if (!reason) {
    errorEl.innerText = "Please provide the reason for rejection / rework.";
    errorEl.style.display = "block";
    return;
  }

  try {
    const now = Timestamp.now();
    await updateDoc(doc(db, "Complaints", id), {
      status: "Rejected",
      "resolution.status": "Rejected",
      "resolution.rejectionReason": reason,
      timeline: arrayUnion({
        stage: "Rejected",
        timestamp: now,
        actor: "Municipal Officer",
        note: `Resolution rejected: ${reason}`
      })
    });

    closeVerificationModal();
  } catch (err) {
    console.error("Rejection error:", err);
    alert("Failed to record rejection.");
  }
});

/* ================= 9. PUBLIC PROOF & TIMELINE MODAL ================= */

window.openPublicProofModal = (complaintId) => {
  const item = allComplaintsCache.find(c => c.id === complaintId);
  if (!item) return;

  document.getElementById("publicModalTitle").innerText = `${item.issueType} (${item.ward})`;

  // Before image
  const beforeCont = document.getElementById("publicModalBeforeContainer");
  if (item.imageUrl) {
    beforeCont.innerHTML = `<img src="${item.imageUrl}" class="proof-img" alt="Before" onerror="this.outerHTML='<div class=proof-placeholder>Image unavailable</div>'">`;
  } else {
    beforeCont.innerHTML = `<div class="proof-placeholder">No citizen photo attached</div>`;
  }

  // After image
  const afterCont = document.getElementById("publicModalAfterContainer");
  if (item.resolution?.evidenceUrl) {
    afterCont.innerHTML = `<img src="${item.resolution.evidenceUrl}" class="proof-img" alt="After" onerror="this.outerHTML='<div class=proof-placeholder>Image unavailable</div>'">`;
  } else {
    afterCont.innerHTML = `<div class="proof-placeholder">Resolution photo pending / in progress</div>`;
  }

  // Verification badge & Attribution (STRICT PRIVACY: NO ADMIN EMAIL OR UID)
  const isVerified = item.status === "Resolved" && item.resolution?.status === "Verified";
  const verifBadge = document.getElementById("publicModalVerificationBadge");
  const evidBadge = document.getElementById("publicModalEvidenceTypeBadge");

  if (isVerified) {
    verifBadge.innerHTML = "✓ Verified by CivicWatch Municipal Officer";
    verifBadge.className = "verified-badge";
  } else if (item.status === "Resolved") {
    verifBadge.innerHTML = "Legacy Resolved (Self-Certified)";
    verifBadge.className = "verified-badge";
  } else {
    verifBadge.innerHTML = `Status: ${item.status}`;
    verifBadge.className = "grade-badge grade-warning";
  }

  if (item.resolution?.evidenceType === "firebase_storage") {
    evidBadge.innerText = "Official Firebase Storage Evidence";
  } else if (item.resolution?.evidenceUrl) {
    evidBadge.innerText = "External Evidence Link";
  } else {
    evidBadge.innerText = "No after-photo recorded";
  }

  document.getElementById("publicModalDescription").innerText = item.resolution?.description || "Work in progress or pending formal resolution notes.";

  // Score breakdown
  const scoreCalc = calculateResolutionScore(item);
  document.getElementById("publicModalScoreVal").innerHTML = `${scoreCalc.score} <span>/ 100</span>`;
  document.getElementById("publicScoreVerif").innerText = `${scoreCalc.breakdown.verification} / ${scoreCalc.breakdown.maxVerification} pts`;
  document.getElementById("publicScoreTime").innerText = `${scoreCalc.breakdown.timeliness} / ${scoreCalc.breakdown.maxTimeliness} pts (SLA: ${scoreCalc.breakdown.slaDays}d, Elapsed: ${scoreCalc.breakdown.elapsedDays}d)`;
  document.getElementById("publicScoreEvid").innerText = `${scoreCalc.breakdown.evidence} / ${scoreCalc.breakdown.maxEvidence} pts`;
  document.getElementById("publicScorePenalties").innerText = scoreCalc.breakdown.penalties > 0 ? `-${scoreCalc.breakdown.penalties} pts` : "0 pts";

  // Ground Spot Check Protocol Widget inside Modal
  const spotCheckContainer = document.getElementById("publicModalSpotCheckContainer");
  if (spotCheckContainer) {
    const hasEvidence = item.status === "Resolved" || item.status === "Resolution Submitted" || item.status === "Under Verification" || item.resolution?.evidenceUrl;
    if (hasEvidence) {
      spotCheckContainer.style.display = "block";
      spotCheckContainer.innerHTML = `
        <div class="spot-check-container">
          <div class="spot-check-header">
            <span>🔍 Community Ground Spot Check</span>
            <span style="font-size: 0.72rem; color: #64748b;">Physical Verification</span>
          </div>
          <div class="spot-check-counts">
            <span style="color: #16a34a;">✓ ${item.verificationsCount || 0} Confirmed</span>
            <span style="color: #dc2626;">✕ ${item.rejectionsCount || 0} Disputed</span>
          </div>
          <div class="spot-check-btn-group">
            <button type="button" class="spot-btn spot-btn-confirm" onclick="performSpotCheck('${item.id}', 'CONFIRM')">
              ✓ Confirm Fix on Site
            </button>
            <button type="button" class="spot-btn spot-btn-dispute" onclick="performSpotCheck('${item.id}', 'DISPUTE')">
              ✕ Dispute Fix (False Closure)
            </button>
          </div>
        </div>
      `;
    } else {
      spotCheckContainer.style.display = "none";
    }
  }

  // Timeline list (Privacy-safe: Generic actor labels only)
  const timelineCont = document.getElementById("publicModalTimelineContainer");
  const timelineData = item.timeline && item.timeline.length > 0
    ? item.timeline
    : [
        {
          stage: "Reported",
          timestamp: item.createdAt,
          actor: "Citizen",
          note: "Issue lodged by citizen"
        },
        ...(item.status === "Resolved" ? [{
          stage: "Resolved",
          timestamp: item.createdAt,
          actor: "Municipal Officer",
          note: "Marked resolved"
        }] : [])
      ];

  timelineCont.innerHTML = "";
  timelineData.forEach((t, idx) => {
    const isLast = idx === timelineData.length - 1;
    const timeStr = t.timestamp ? new Date(getTimestampMillis(t.timestamp)).toLocaleString() : "-";
    const safeActor = t.actor === "Citizen" ? "Citizen" : "Municipal Officer";

    timelineCont.innerHTML += `
      <div class="timeline-item ${isLast ? 'active' : ''}">
        <div class="timeline-dot"></div>
        <div class="timeline-title">${t.stage}</div>
        <div class="timeline-meta">${timeStr} • <strong>${safeActor}</strong></div>
        <div class="timeline-note">${t.note || ""}</div>
      </div>
    `;
  });

  document.getElementById("publicProofModal").classList.add("open");
};

window.closePublicProofModal = () => {
  document.getElementById("publicProofModal")?.classList.remove("open");
};

/* ================= 10. SCORING EXPLAINER MODAL ================= */

window.openScoringExplainerModal = () => {
  document.getElementById("scoringExplainerModal")?.classList.add("open");
};

window.closeScoringExplainerModal = () => {
  document.getElementById("scoringExplainerModal")?.classList.remove("open");
};

/* ================= 11. ADMIN TAB SWITCHING ================= */

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));

    btn.classList.add("active");
    const targetTab = document.getElementById(btn.getAttribute("data-tab"));
    if (targetTab) targetTab.classList.add("active");
  });
});

/* ================= 12. REAL-TIME FIRESTORE SYNCHRONIZATION ================= */

onSnapshot(collection(db, "Complaints"), (snapshot) => {
  allComplaintsCache = [];
  snapshot.forEach((docSnap) => {
    allComplaintsCache.push({
      id: docSnap.id,
      ...docSnap.data()
    });
  });

  // Re-render active views
  loadIssues();
  loadAdmin();
  wardDashboard();
});

// Initial trigger
loadIssues();
loadAdmin();
wardDashboard();
