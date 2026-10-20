/**
 * CivicWatch - Resolution Engine & Advanced Ward Performance
 * Pure, deterministic, rule-based calculations without AI or fabricated data.
 */

import { storage } from "./firebase.js";
import {
  ref,
  uploadBytesResumable,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

/* ================= CONFIGURATION & WEIGHTS ================= */

export const SEVERITY_MAP = {
  "Open Manhole": 5,
  "Drainage Blockage": 4,
  "Pothole": 3,
  "Water Leakage": 3,
  "Garbage Overflow": 2,
  "Broken Streetlight": 2
};

export const SLA_DAYS = {
  "Open Manhole": 2,
  "Drainage Blockage": 3,
  "Pothole": 5,
  "Water Leakage": 5,
  "Garbage Overflow": 7,
  "Broken Streetlight": 7,
  "Default": 7
};

export const WARD_WEIGHTS = {
  resolutionRate: 0.30,
  timelinessScore: 0.20,
  avgResolutionScore: 0.20,
  highPriorityResolution: 0.10,
  evidenceCompleteness: 0.10,
  reopenDiscipline: 0.10
};

/* ================= HELPER: HAVERSINE DISTANCE IN METERS ================= */
export function getDistanceFromLatLonInM(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return Infinity;
  const R = 6371e3; // Radius of earth in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/* ================= HELPER: PARSE MILLISECONDS ================= */
export function getTimestampMillis(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") return ts.toDate().getTime();
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

/* ================= 1. RECIDIVISM CHECK UTILITY ================= */
/**
 * Checks if a newly reported issue has a matching closed/resolved issue
 * within a maxDistanceMeters (default 25m) radius closed in the last maxDaysAgo (default 60 days).
 */
export function checkRecidivism(newLat, newLon, issueType, existingComplaintsList = [], maxDistanceMeters = 25, maxDaysAgo = 60) {
  if (newLat == null || newLon == null || !existingComplaintsList || existingComplaintsList.length === 0) {
    return { isRecidivist: false };
  }

  const now = Date.now();
  const maxMillisAgo = maxDaysAgo * 24 * 60 * 60 * 1000;

  for (const c of existingComplaintsList) {
    const isClosed = c.status === "Resolved" || c.resolution?.status === "Verified";
    if (isClosed && c.issueType === issueType && c.latitude != null && c.longitude != null) {
      const dist = getDistanceFromLatLonInM(newLat, newLon, c.latitude, c.longitude);
      if (dist <= maxDistanceMeters) {
        const closedTime = getTimestampMillis(c.resolution?.verifiedAt) || getTimestampMillis(c.createdAt) || now;
        const elapsedMillis = now - closedTime;
        if (elapsedMillis <= maxMillisAgo) {
          const daysSince = Math.max(0, Math.floor(elapsedMillis / (24 * 60 * 60 * 1000)));
          return {
            isRecidivist: true,
            previousIssueId: c.id,
            daysSinceResolution: daysSince,
            distanceMeters: Math.round(dist)
          };
        }
      }
    }
  }

  return { isRecidivist: false };
}

/* ================= 2. RESOLUTION SCORE (0-100) ================= */
/**
 * Calculates a 100-point transparent rule-based score for an issue:
 * - Verification Quality: Max 40 pts
 * - Timeliness vs SLA: Max 30 pts
 * - Evidence Completeness: Max 30 pts
 * - Spot Check Bonus / Penalty
 * - Recidivism Penalty
 * - Penalties: Rejection (-15), Reopen (-20)
 * Clamped: max(0, min(100, Total))
 */
export function calculateResolutionScore(issue) {
  if (!issue) {
    return {
      score: 0,
      breakdown: {
        verification: 0,
        maxVerification: 40,
        timeliness: 0,
        maxTimeliness: 30,
        evidence: 0,
        maxEvidence: 30,
        spotCheckBonus: 0,
        penalties: 0,
        slaDays: 7,
        elapsedDays: 0
      },
      status: "Unprocessed",
      isVerified: false,
      isOfficialEvidence: false
    };
  }

  const res = issue.resolution || {};
  const status = issue.status || "Reported";
  const issueType = issue.issueType || "Other";
  const sla = SLA_DAYS[issueType] || SLA_DAYS["Default"];

  const createdMillis = getTimestampMillis(issue.createdAt) || Date.now();
  const submittedMillis = getTimestampMillis(res.submittedAt);
  const verifiedMillis = getTimestampMillis(res.verifiedAt);
  const resolvedEndMillis = submittedMillis || verifiedMillis || (status === "Resolved" ? createdMillis : Date.now());

  const elapsedDays = Math.max(0, Math.floor((resolvedEndMillis - createdMillis) / (1000 * 60 * 60 * 24)));

  // A. Verification Quality (Max 40)
  let verificationPts = 0;
  const isOfficiallyVerified = res.status === "Verified" || (status === "Resolved" && res.verifiedAt);
  const isSubmitted = status === "Resolution Submitted" || status === "Under Verification" || res.status === "Submitted";
  const isRejected = status === "Rejected" || res.status === "Rejected";

  if (isOfficiallyVerified) {
    verificationPts = 40;
  } else if (isSubmitted) {
    verificationPts = 25;
  } else if (status === "Resolved") {
    verificationPts = 10;
  } else if (isRejected) {
    verificationPts = 0;
  }

  // B. Timeliness (Max 30)
  let timelinessPts = 5;
  if (elapsedDays <= sla) {
    timelinessPts = 30;
  } else if (elapsedDays <= sla * 2) {
    timelinessPts = 20;
  } else if (elapsedDays <= sla * 3) {
    timelinessPts = 10;
  } else {
    timelinessPts = 5;
  }

  // C. Evidence Completeness (Max 30)
  let evidencePts = 0;
  const isOfficialEvidence = res.evidenceUrl && res.evidenceType === "firebase_storage";
  const isExternalEvidence = res.evidenceUrl && res.evidenceType !== "firebase_storage";

  if (isOfficialEvidence) {
    evidencePts += 15;
  } else if (isExternalEvidence) {
    evidencePts += 5;
  }

  if (res.description && res.description.trim().length >= 20) {
    evidencePts += 10;
  } else if (res.description && res.description.trim().length > 0) {
    evidencePts += 5;
  }

  if (issue.imageUrl && issue.imageUrl.trim().length > 0) {
    evidencePts += 5;
  }

  // D. Spot Check Protocol adjustments
  let spotCheckBonus = 0;
  const verificationsCount = issue.verificationsCount || 0;
  const rejectionsCount = issue.rejectionsCount || 0;

  if (verificationsCount >= 2 && rejectionsCount === 0) {
    spotCheckBonus = 5; // Community ground verified
  }

  // E. Penalties
  let penaltyPts = 0;
  const hasRejection = isRejected || res.rejectionReason || (issue.timeline && issue.timeline.some(t => t.stage === "Rejected"));
  const hasReopen = status === "Reopened" || res.reopenedAt || (issue.timeline && issue.timeline.some(t => t.stage === "Reopened"));

  if (hasRejection) penaltyPts += 15;
  if (hasReopen) penaltyPts += 20;
  if (rejectionsCount > 0) penaltyPts += Math.min(20, rejectionsCount * 10); // Citizen dispute penalty
  if (issue.isRecidivist) penaltyPts += 10; // Recurrent defect penalty

  const rawTotal = verificationPts + timelinessPts + evidencePts + spotCheckBonus - penaltyPts;
  const score = Math.max(0, Math.min(100, rawTotal));

  return {
    score,
    breakdown: {
      verification: verificationPts,
      maxVerification: 40,
      timeliness: timelinessPts,
      maxTimeliness: 30,
      evidence: evidencePts,
      maxEvidence: 30,
      spotCheckBonus,
      penalties: penaltyPts,
      slaDays: sla,
      elapsedDays
    },
    isVerified: isOfficiallyVerified,
    isOfficialEvidence
  };
}

/* ================= 3. WARD PERFORMANCE SCORING ================= */
/**
 * Aggregates all complaints dynamically by ward and computes multi-factor scores
 * with dynamic penalty deductions for:
 * - Overdue SLA deadlines
 * - Recurring infrastructure defects (isRecidivist)
 * - Failed spot checks (rejectionsCount)
 */
export function calculateWardPerformance(complaintsList = []) {
  const wardMap = {};
  const now = Date.now();

  complaintsList.forEach((docData) => {
    const wardName = docData.ward || "Unassigned";
    if (!wardMap[wardName]) {
      wardMap[wardName] = {
        ward: wardName,
        totalIssues: 0,
        resolvedIssues: [],
        allIssues: [],
        highPriorityTotal: 0,
        highPriorityResolved: 0,
        reopenedCount: 0,
        totalOverdueDays: 0,
        recidivistCount: 0,
        totalSpotCheckRejections: 0
      };
    }

    const group = wardMap[wardName];
    group.totalIssues += 1;
    group.allIssues.push(docData);

    const isResolved = docData.status === "Resolved";
    const severity = SEVERITY_MAP[docData.issueType] || 1;
    const isHighPriority = severity >= 4 || (docData.reports && docData.reports >= 3);

    if (isHighPriority) {
      group.highPriorityTotal += 1;
      if (isResolved) group.highPriorityResolved += 1;
    }

    if (isResolved) {
      group.resolvedIssues.push(docData);
    } else {
      // Check for overdue SLA on active issues
      const createdMillis = getTimestampMillis(docData.createdAt) || now;
      const slaDays = SLA_DAYS[docData.issueType] || 7;
      const slaDeadlineMillis = getTimestampMillis(docData.slaDeadline) || (createdMillis + (slaDays * 86400000));
      if (now > slaDeadlineMillis) {
        const overdueDays = Math.floor((now - slaDeadlineMillis) / 86400000);
        group.totalOverdueDays += Math.max(1, overdueDays);
      }
    }

    if (docData.isRecidivist) {
      group.recidivistCount += 1;
    }

    if (docData.rejectionsCount && docData.rejectionsCount > 0) {
      group.totalSpotCheckRejections += docData.rejectionsCount;
    }

    const isReopened = docData.status === "Reopened" ||
      docData.resolution?.reopenedAt ||
      (docData.timeline && docData.timeline.some(t => t.stage === "Reopened"));

    if (isReopened) {
      group.reopenedCount += 1;
    }
  });

  const wardResults = [];

  Object.values(wardMap).forEach((group) => {
    const total = group.totalIssues;
    const resolvedCount = group.resolvedIssues.length;
    const resolutionRate = total > 0 ? (resolvedCount / total) * 100 : 0;

    // Calculate metrics across resolved complaints
    let sumTimelinessNorm = 0;
    let sumResScore = 0;
    let officialEvidenceCount = 0;
    let verifiedCount = 0;
    let totalElapsedDays = 0;

    group.resolvedIssues.forEach((issue) => {
      const resCalc = calculateResolutionScore(issue);
      sumResScore += resCalc.score;
      sumTimelinessNorm += (resCalc.breakdown.timeliness / resCalc.breakdown.maxTimeliness) * 100;
      totalElapsedDays += resCalc.breakdown.elapsedDays;

      if (resCalc.isOfficialEvidence) {
        officialEvidenceCount += 1;
      }
      if (resCalc.isVerified) {
        verifiedCount += 1;
      }
    });

    const avgTimelinessScore = resolvedCount > 0 ? sumTimelinessNorm / resolvedCount : 0;
    const avgResolutionScore = resolvedCount > 0 ? Math.round(sumResScore / resolvedCount) : 0;
    const avgResolutionDays = resolvedCount > 0 ? (totalElapsedDays / resolvedCount).toFixed(1) : "-";
    const evidenceRate = resolvedCount > 0 ? (officialEvidenceCount / resolvedCount) * 100 : 0;
    const verifiedRate = resolvedCount > 0 ? Math.round((verifiedCount / resolvedCount) * 100) : 0;

    const highPriorityRate = group.highPriorityTotal > 0
      ? (group.highPriorityResolved / group.highPriorityTotal) * 100
      : 100;

    const reopenRate = total > 0 ? (group.reopenedCount / total) * 100 : 0;
    const reopenDiscipline = Math.max(0, 100 - reopenRate);

    // Dynamic Penalty Deductions:
    const overduePenalty = Math.min(20, group.totalOverdueDays * 2);
    const recidivismPenalty = Math.min(25, group.recidivistCount * 5);
    const spotCheckPenalty = Math.min(15, group.totalSpotCheckRejections * 3);
    const totalPenalties = overduePenalty + recidivismPenalty + spotCheckPenalty;

    // Weighted Ward Score (0-100)
    const baseScore = total === 0 ? 0 : Math.round(
      (WARD_WEIGHTS.resolutionRate * resolutionRate) +
      (WARD_WEIGHTS.timelinessScore * avgTimelinessScore) +
      (WARD_WEIGHTS.avgResolutionScore * avgResolutionScore) +
      (WARD_WEIGHTS.highPriorityResolution * highPriorityRate) +
      (WARD_WEIGHTS.evidenceCompleteness * evidenceRate) +
      (WARD_WEIGHTS.reopenDiscipline * reopenDiscipline)
    );

    const score = Math.max(0, Math.min(100, baseScore - totalPenalties));

    // Performance Grades
    let grade = "Poor";
    let gradeClass = "grade-danger";
    if (score >= 90) {
      grade = "Excellent";
      gradeClass = "grade-excellent";
    } else if (score >= 75) {
      grade = "Good";
      gradeClass = "grade-good";
    } else if (score >= 60) {
      grade = "Needs Improvement";
      gradeClass = "grade-warning";
    }

    const isLowSample = total < 3;

    wardResults.push({
      ward: group.ward,
      score,
      baseScore,
      grade,
      gradeClass,
      totalIssues: total,
      resolvedCount,
      resolutionRate: Math.round(resolutionRate),
      avgResolutionScore,
      avgResolutionDays,
      verifiedRate,
      officialEvidenceCount,
      isLowSample,
      penalties: {
        overduePenalty,
        recidivismPenalty,
        spotCheckPenalty,
        totalPenalties,
        totalOverdueDays: group.totalOverdueDays,
        recidivistCount: group.recidivistCount,
        totalSpotCheckRejections: group.totalSpotCheckRejections
      },
      metrics: {
        resolutionRate: Math.round(resolutionRate),
        timelinessScore: Math.round(avgTimelinessScore),
        avgResolutionScore,
        highPriorityRate: Math.round(highPriorityRate),
        evidenceRate: Math.round(evidenceRate),
        reopenDiscipline: Math.round(reopenDiscipline)
      }
    });
  });

  // Rank descending by score
  wardResults.sort((a, b) => b.score - a.score || b.totalIssues - a.totalIssues);
  wardResults.forEach((w, index) => {
    w.rank = index + 1;
  });

  return wardResults;
}

/* ================= 4. CATEGORY PERFORMANCE MATRIX ================= */
export function calculateCategoryMetrics(complaintsList = []) {
  const catMap = {};

  complaintsList.forEach((issue) => {
    const cat = issue.issueType || "Other";
    if (!catMap[cat]) {
      catMap[cat] = {
        category: cat,
        total: 0,
        resolved: 0,
        sumScore: 0,
        sumDays: 0
      };
    }

    const g = catMap[cat];
    g.total += 1;
    if (issue.status === "Resolved") {
      g.resolved += 1;
      const resCalc = calculateResolutionScore(issue);
      g.sumScore += resCalc.score;
      g.sumDays += resCalc.breakdown.elapsedDays;
    }
  });

  return Object.values(catMap).map((g) => {
    const rate = g.total > 0 ? Math.round((g.resolved / g.total) * 100) : 0;
    const avgScore = g.resolved > 0 ? Math.round(g.sumScore / g.resolved) : 0;
    const avgTime = g.resolved > 0 ? (g.sumDays / g.resolved).toFixed(1) + " days" : "-";

    return {
      category: g.category,
      total: g.total,
      resolved: g.resolved,
      resolutionRate: rate,
      avgScore,
      avgTime
    };
  }).sort((a, b) => b.total - a.total);
}

/* ================= 5. FIREBASE STORAGE EVIDENCE UPLOAD ================= */
export function uploadResolutionEvidence(file, issueId, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    if (!file) {
      return reject(new Error("No file provided for resolution evidence."));
    }

    // Validation 1: Allowed MIME type
    const validMimes = ["image/jpeg", "image/png", "image/webp"];
    if (!validMimes.includes(file.type)) {
      return reject(new Error("Invalid file type. Only JPEG, PNG, and WebP images are allowed."));
    }

    // Validation 2: Maximum 5MB
    const maxBytes = 5 * 1024 * 1024;
    if (file.size > maxBytes) {
      return reject(new Error("File exceeds maximum allowed size of 5 MB."));
    }

    const cleanName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_");
    const filePath = `resolution_evidence/${issueId}_${Date.now()}_${cleanName}`;
    const storageRef = ref(storage, filePath);
    const uploadTask = uploadBytesResumable(storageRef, file);

    uploadTask.on(
      "state_changed",
      (snapshot) => {
        const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
        onProgress(Math.round(progress));
      },
      (error) => {
        console.error("Storage upload failed:", error);
        reject(error);
      },
      async () => {
        try {
          const downloadUrl = await getDownloadURL(uploadTask.snapshot.ref);
          resolve({
            downloadUrl,
            evidenceType: "firebase_storage",
            filePath
          });
        } catch (err) {
          reject(err);
        }
      }
    );
  });
}
