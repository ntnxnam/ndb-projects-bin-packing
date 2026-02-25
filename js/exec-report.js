/**
 * Executive Report PDF generator.
 * Captures the Gantt chart via html2canvas and combines it with
 * jsPDF-drawn text sections for a polished, shareable PDF.
 * @module exec-report
 */

import { getEl, formatDate } from './utils.js';
import { totalResources } from './sizing.js';
import { getLongPoles, getScheduleEnd } from './bin-packing.js';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/* ── Color palette (matches the dark UI, adapted for white-bg PDF) ── */
const C = {
  navy:    '#1a2332',
  accent:  '#2563eb',
  heading: '#1e293b',
  body:    '#334155',
  muted:   '#64748b',
  red:     '#dc2626',
  amber:   '#d97706',
  green:   '#16a34a',
  divider: '#e2e8f0',
  bgLight: '#f8fafc',
};

/* ── Helpers ── */

function monthsBetween(a, b) {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / MONTH_MS));
}

function pct(v, total) {
  return total > 0 ? Math.round((v / total) * 100) : 0;
}

/**
 * Build PDF and trigger download.
 * @param {{ schedule, projects, startDate, endDate, numFTEs, capacityPct, capacity }} ctx
 */
export async function generateExecReport(ctx) {
  const { schedule, projects, startDate, endDate, numFTEs, capacityPct, capacity } = ctx;
  const jsPDF = window.jspdf?.jsPDF;
  if (!jsPDF) throw new Error('jsPDF not loaded');

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;
  const contentW = pageW - margin * 2;
  let y = margin;

  /* ───────── PAGE 1 : TITLE + KEY METRICS + GANTT ───────── */

  /* Header bar */
  doc.setFillColor(C.navy);
  doc.rect(0, 0, pageW, 56, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor('#ffffff');
  doc.text('NDB 3.0 - Executive Schedule Report', margin, 36);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor('#94a3b8');
  doc.text(`Generated ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`, pageW - margin, 36, { align: 'right' });

  y = 72;

  /* ── Parameters strip ── */
  doc.setFillColor(C.bgLight);
  doc.roundedRect(margin, y, contentW, 28, 4, 4, 'F');
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(C.muted);
  const paramStr = [
    `Headcount: ${numFTEs}`,
    `Capacity: ${capacityPct}%`,
    `Start: ${formatDate(startDate)}`,
    `Target: ${formatDate(endDate)}`,
    `Projects: ${projects.length}`,
  ].join('   |   ');
  doc.text(paramStr, margin + 10, y + 18);
  y += 40;

  /* ── Key metrics cards ── */
  const timelineEnd = getScheduleEnd(schedule) || endDate;
  const timelineMonths = monthsBetween(startDate, timelineEnd);
  const deadlineMs = endDate.getTime();
  const pastDeadline = schedule.filter(e => !e.isResourceGroupChild && e.endDate.getTime() > deadlineMs);
  const longPoles = getLongPoles(schedule, timelineEnd, 0.25);

  const usageByMonth = new Map();
  for (const e of schedule) {
    if (e.isResourceGroupChild) continue;
    const fte = e.fte ?? totalResources(e.project);
    const sMs = e.startDate.getTime();
    const eMs = e.endDate.getTime();
    const sMo = Math.round((sMs - startDate.getTime()) / MONTH_MS);
    const eMo = Math.round((eMs - startDate.getTime()) / MONTH_MS);
    for (let m = sMo; m < eMo; m++) usageByMonth.set(m, (usageByMonth.get(m) ?? 0) + fte);
  }
  const totalMonths = Math.max(1, monthsBetween(startDate, timelineEnd));
  let sumUtil = 0;
  for (let m = 0; m < totalMonths; m++) {
    sumUtil += pct(usageByMonth.get(m) ?? 0, numFTEs);
  }
  const avgUtil = Math.round(sumUtil / totalMonths);

  const targetMonths = monthsBetween(startDate, endDate);
  const overrun = timelineMonths > targetMonths;
  const cards = [
    { label: 'Target',          value: `${targetMonths} mo`,  color: C.accent },
    { label: 'Scheduled',       value: `${timelineMonths} mo`, color: overrun ? C.red : C.green, sub: overrun ? `+${timelineMonths - targetMonths} mo overrun` : 'On track' },
    { label: 'Avg Utilization', value: `${avgUtil}%`,          color: avgUtil > 85 ? C.red : avgUtil > 70 ? C.amber : C.green },
    { label: 'Long Poles',      value: `${longPoles.length}`,  color: longPoles.length > 3 ? C.amber : C.green },
    { label: 'Past Target',     value: `${pastDeadline.length}`, color: pastDeadline.length > 0 ? C.red : C.green },
  ];
  const cardW = (contentW - 24) / 5;
  const cardH = 52;
  cards.forEach((card, i) => {
    const cx = margin + i * (cardW + 6);
    doc.setFillColor('#ffffff');
    doc.setDrawColor(C.divider);
    doc.roundedRect(cx, y, cardW, cardH, 4, 4, 'FD');
    doc.setFontSize(20);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(card.color);
    doc.text(card.value, cx + cardW / 2, y + 22, { align: 'center' });
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(C.muted);
    doc.text(card.label, cx + cardW / 2, y + 34, { align: 'center' });
    if (card.sub) {
      doc.setFontSize(6.5);
      doc.setTextColor(card.color);
      doc.text(card.sub, cx + cardW / 2, y + 44, { align: 'center' });
    }
  });
  y += cardH + 14;

  /* ── Gantt chart capture ── */
  const ganttSection = getEl('ganttSection');
  if (ganttSection) {
    const ganttWrapper = ganttSection.querySelector('.gantt-wrapper');
    if (ganttWrapper) {
      const remainingH = pageH - y - margin;

      /* Temporarily expand the scroll container so the full chart
         (including bars past the viewport) is rendered for capture. */
      const scrollBox = ganttWrapper.querySelector('.gantt-chart-scroll');
      const savedOverflow = scrollBox?.style.overflow;
      const savedMaxW = scrollBox?.style.maxWidth;
      if (scrollBox) {
        scrollBox.style.overflow = 'visible';
        scrollBox.style.maxWidth = 'none';
      }
      const savedWrapperOverflow = ganttWrapper.style.overflow;
      ganttWrapper.style.overflow = 'visible';

      try {
        const fullW = ganttWrapper.scrollWidth;
        const fullH = ganttWrapper.scrollHeight;
        const canvas = await html2canvas(ganttWrapper, {
          backgroundColor: '#0f1419',
          scale: 2,
          useCORS: true,
          logging: false,
          scrollX: 0,
          scrollY: 0,
          width: fullW,
          height: fullH,
          windowWidth: fullW,
          windowHeight: fullH,
        });
        const imgData = canvas.toDataURL('image/png');
        const imgAspect = canvas.width / canvas.height;
        let imgW = contentW;
        let imgH = imgW / imgAspect;
        if (imgH > remainingH) {
          imgH = remainingH;
          imgW = imgH * imgAspect;
        }
        doc.addImage(imgData, 'PNG', margin, y, imgW, imgH);
        y += imgH + 10;
      } catch (err) {
        doc.setFontSize(9);
        doc.setTextColor(C.muted);
        doc.text('[Gantt chart capture failed]', margin, y + 12);
        y += 20;
      } finally {
        if (scrollBox) {
          scrollBox.style.overflow = savedOverflow ?? '';
          scrollBox.style.maxWidth = savedMaxW ?? '';
        }
        ganttWrapper.style.overflow = savedWrapperOverflow ?? '';
      }
    }
  }

  /* ───────── PAGE 2 : DETAILS ───────── */
  doc.addPage('a4', 'landscape');
  y = margin;

  /* Header bar (page 2) */
  doc.setFillColor(C.navy);
  doc.rect(0, 0, pageW, 42, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor('#ffffff');
  doc.text('Schedule Details', margin, 28);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor('#94a3b8');
  doc.text('Page 2', pageW - margin, 28, { align: 'right' });
  y = 56;

  const colLeft = margin;
  const colRight = margin + contentW / 2 + 10;
  const halfW = contentW / 2 - 10;

  /* ── Left column: Spare Capacity mini chart (drawn) ── */
  drawSectionTitle(doc, 'Spare Capacity', colLeft, y);
  y += 16;
  const chartH = 80;
  const chartW = halfW;
  const maxMonths = totalMonths;
  const barW = Math.max(2, chartW / maxMonths);
  const maxVal = Math.max(numFTEs, 1);

  doc.setDrawColor(C.divider);
  doc.setFillColor(C.bgLight);
  doc.roundedRect(colLeft, y, chartW, chartH + 20, 3, 3, 'FD');

  for (let m = 0; m < maxMonths; m++) {
    const used = usageByMonth.get(m) ?? 0;
    const utilPct = pct(used, numFTEs);
    const bh = (used / maxVal) * chartH;
    const bx = colLeft + 4 + m * ((chartW - 8) / maxMonths);
    const by = y + 4 + chartH - bh;
    const fill = utilPct > 85 ? C.red : utilPct > 70 ? C.amber : C.green;
    doc.setFillColor(fill);
    doc.rect(bx, by, Math.max(1, barW - 1), bh, 'F');
  }

  /* Capacity line */
  const capLineY = y + 4;
  doc.setDrawColor(C.green);
  doc.setLineWidth(0.5);
  doc.line(colLeft + 4, capLineY, colLeft + chartW - 4, capLineY);
  doc.setFontSize(6);
  doc.setTextColor(C.green);
  doc.text(`${numFTEs} cap`, colLeft + chartW - 6, capLineY - 2, { align: 'right' });

  y += chartH + 28;

  /* ── Left column: Insights ── */
  drawSectionTitle(doc, 'Insights', colLeft, y);
  y += 14;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(C.body);

  const highMonths = [];
  const lowMonths = [];
  for (let m = 0; m < maxMonths; m++) {
    const utilPct = pct(usageByMonth.get(m) ?? 0, numFTEs);
    const d = new Date(startDate.getFullYear(), startDate.getMonth() + m, 1);
    const lbl = d.toLocaleString('default', { month: 'short', year: '2-digit' });
    if (utilPct > 85) highMonths.push(lbl);
    if (utilPct < 50) lowMonths.push(lbl);
  }

  const insightLines = [];
  if (highMonths.length) insightLines.push({ dot: C.red, text: `High utilization (>85%): ${highMonths.slice(0, 6).join(', ')}${highMonths.length > 6 ? '...' : ''}` });
  if (lowMonths.length) insightLines.push({ dot: C.green, text: `Capacity available (<50%): ${lowMonths.slice(0, 6).join(', ')}${lowMonths.length > 6 ? '...' : ''}` });
  insightLines.push({ dot: C.accent, text: `Average utilization: ${avgUtil}% across ${totalMonths} months` });

  for (const ins of insightLines) {
    doc.setFillColor(ins.dot);
    doc.circle(colLeft + 4, y + 3, 2.5, 'F');
    doc.setTextColor(C.body);
    doc.text(ins.text, colLeft + 12, y + 6);
    y += 12;
  }

  /* ── Right column: Long Poles ── */
  let yRight = 56 + 16;
  drawSectionTitle(doc, `Long Poles (${longPoles.length})`, colRight, yRight - 16);
  if (longPoles.length === 0) {
    doc.setFontSize(8);
    doc.setTextColor(C.muted);
    doc.text('No long poles -- all projects finish well before timeline end.', colRight, yRight + 6);
    yRight += 14;
  } else {
    yRight = drawProjectTable(doc, longPoles, colRight, yRight, halfW, endDate);
  }

  yRight += 10;

  /* ── Right column: Past Target Date ── */
  drawSectionTitle(doc, `Past Target Date (${pastDeadline.length})`, colRight, yRight);
  yRight += 14;
  if (pastDeadline.length === 0) {
    doc.setFontSize(8);
    doc.setTextColor(C.green);
    doc.text('All projects finish within target -- no action needed.', colRight, yRight + 4);
    yRight += 14;
  } else {
    yRight = drawProjectTable(doc, pastDeadline, colRight, yRight, halfW, endDate);
  }

  yRight += 10;

  /* ── Right column: Recommendations ── */
  drawSectionTitle(doc, 'Recommendations', colRight, yRight);
  yRight += 14;
  const recommendations = buildRecommendations(schedule, endDate, capacityPct, numFTEs, longPoles, pastDeadline);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  for (const rec of recommendations) {
    doc.setTextColor(rec.color || C.body);
    const lines = doc.splitTextToSize(rec.text, halfW - 8);
    for (const line of lines) {
      if (yRight > pageH - margin) break;
      doc.text(line, colRight + 4, yRight + 4);
      yRight += 10;
    }
    yRight += 4;
  }

  /* ───────── PAGE 3 : PROJECT TABLE ───────── */
  doc.addPage('a4', 'landscape');
  y = margin;
  doc.setFillColor(C.navy);
  doc.rect(0, 0, pageW, 42, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor('#ffffff');
  doc.text('Project List', margin, 28);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor('#94a3b8');
  doc.text('Page 3', pageW - margin, 28, { align: 'right' });
  y = 56;

  drawFullProjectTable(doc, schedule, projects, margin, y, contentW, pageH, margin, startDate, endDate);

  /* ── Footer on every page ── */
  const totalPages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setTextColor(C.muted);
    doc.text(`NDB 3.0 Executive Report  |  Page ${i} of ${totalPages}`, pageW / 2, pageH - 16, { align: 'center' });
  }

  /* Download */
  const dateStr = new Date().toISOString().slice(0, 10);
  doc.save(`NDB-Exec-Report-${dateStr}.pdf`);
}

/* ─────────────────── Drawing helpers ─────────────────── */

function drawSectionTitle(doc, title, x, y) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(C.heading);
  doc.text(title, x, y + 10);
  doc.setDrawColor(C.accent);
  doc.setLineWidth(1.5);
  doc.line(x, y + 13, x + doc.getTextWidth(title), y + 13);
  doc.setLineWidth(0.5);
}

function drawProjectTable(doc, entries, x, y, width, endDate) {
  const cols = [
    { label: 'Sl No', w: 36 },
    { label: 'Project', w: width - 36 - 50 - 60 - 50 },
    { label: 'FEAT', w: 60 },
    { label: 'Ends', w: 50 },
    { label: 'People', w: 50 },
  ];

  /* Header */
  doc.setFillColor(C.navy);
  doc.rect(x, y, width, 14, 'F');
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor('#ffffff');
  let cx = x + 3;
  for (const col of cols) {
    doc.text(col.label, cx, y + 10);
    cx += col.w;
  }
  y += 16;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  const maxRows = Math.min(entries.length, 18);
  for (let i = 0; i < maxRows; i++) {
    const e = entries[i];
    const p = e.project;
    if (i % 2 === 0) {
      doc.setFillColor(C.bgLight);
      doc.rect(x, y - 2, width, 12, 'F');
    }
    doc.setTextColor(C.body);
    cx = x + 3;
    doc.text(String(p.rowNumber ?? '-'), cx, y + 7); cx += cols[0].w;
    const summary = (p.summary || '').slice(0, 45) + ((p.summary || '').length > 45 ? '...' : '');
    doc.text(summary, cx, y + 7); cx += cols[1].w;
    doc.text((p.feat || '').slice(0, 12), cx, y + 7); cx += cols[2].w;
    const endStr = e.endDate ? formatDate(e.endDate) : '-';
    const isPast = endDate && e.endDate && e.endDate.getTime() > endDate.getTime();
    doc.setTextColor(isPast ? C.red : C.body);
    doc.text(endStr, cx, y + 7); cx += cols[3].w;
    doc.setTextColor(C.body);
    const fte = e.fte ?? totalResources(p);
    doc.text(fte > 0 ? fte.toFixed(1) : '-', cx, y + 7);
    y += 12;
  }
  if (entries.length > maxRows) {
    doc.setTextColor(C.muted);
    doc.text(`... and ${entries.length - maxRows} more`, x + 3, y + 7);
    y += 12;
  }
  return y;
}

function drawFullProjectTable(doc, schedule, projects, x, startY, width, pageH, margin, startDate, endDate) {
  const mainEntries = schedule.filter(e => !e.isResourceGroupChild);
  const cols = [
    { label: 'Sl', w: 28 },
    { label: 'Project Summary', w: width - 28 - 70 - 42 - 50 - 50 - 50 - 56 - 56 },
    { label: 'FEAT', w: 70 },
    { label: 'Size', w: 42 },
    { label: 'Duration', w: 50 },
    { label: 'People', w: 50 },
    { label: 'Starts', w: 56 },
    { label: 'Ends', w: 56 },
    { label: 'Status', w: 50 },
  ];

  let y = startY;

  function drawHeader() {
    doc.setFillColor(C.navy);
    doc.rect(x, y, width, 14, 'F');
    doc.setFontSize(6.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor('#ffffff');
    let cx = x + 2;
    for (const col of cols) {
      doc.text(col.label, cx, y + 10);
      cx += col.w;
    }
    y += 16;
  }

  drawHeader();

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);

  for (let i = 0; i < mainEntries.length; i++) {
    if (y > pageH - margin - 20) {
      doc.addPage('a4', 'landscape');
      y = margin;
      doc.setFillColor(C.navy);
      doc.rect(0, 0, pageH > 0 ? doc.internal.pageSize.getWidth() : 842, 42, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.setTextColor('#ffffff');
      doc.text('Project List (cont.)', margin, 28);
      y = 56;
      drawHeader();
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
    }

    const e = mainEntries[i];
    const p = e.project;
    if (i % 2 === 0) {
      doc.setFillColor(C.bgLight);
      doc.rect(x, y - 2, width, 11, 'F');
    }
    doc.setTextColor(C.body);
    let cx = x + 2;
    doc.text(String(p.rowNumber ?? ''), cx, y + 6); cx += cols[0].w;
    const summary = (p.summary || '').slice(0, 55) + ((p.summary || '').length > 55 ? '...' : '');
    doc.text(summary, cx, y + 6); cx += cols[1].w;
    doc.text((p.feat || '').slice(0, 14), cx, y + 6); cx += cols[2].w;
    doc.text(p.sizingLabel ? p.sizingLabel.replace(/\s*\(.*\)/, '') : '-', cx, y + 6); cx += cols[3].w;
    doc.text(p.durationMonths != null ? `${p.durationMonths} mo` : '-', cx, y + 6); cx += cols[4].w;
    const fte = e.fte ?? totalResources(p);
    doc.text(fte > 0 ? fte.toFixed(1) : '-', cx, y + 6); cx += cols[5].w;
    doc.text(e.startDate ? formatDate(e.startDate) : '-', cx, y + 6); cx += cols[6].w;
    const isPast = endDate && e.endDate && e.endDate.getTime() > endDate.getTime();
    doc.setTextColor(isPast ? C.red : C.body);
    doc.text(e.endDate ? formatDate(e.endDate) : '-', cx, y + 6); cx += cols[7].w;
    doc.setTextColor(C.body);
    const completedPct = p.completedPct ?? 0;
    const status = completedPct > 0 ? `${completedPct}%` : (e.inProgress ? 'Active' : 'Planned');
    doc.text(status, cx, y + 6);
    y += 11;
  }
}

function buildRecommendations(schedule, endDate, capacityPct, numFTEs, longPoles, pastDeadline) {
  const recs = [];
  if (pastDeadline.length > 0) {
    const pctFactor = (capacityPct || 100) / 100;
    const addPeople = [];
    let latestEnd = endDate;
    for (const e of pastDeadline) {
      const p = e.project;
      const completedPct = Number(p.completedPct) || 0;
      const totalPM = p.totalPersonMonthsNum;
      const remainFrac = (100 - completedPct) / 100;
      const remainPM = totalPM > 0 ? totalPM * remainFrac : 0;
      const availMonths = endDate && e.startDate
        ? Math.max(1, Math.round((endDate.getTime() - e.startDate.getTime()) / MONTH_MS))
        : 0;
      if (remainPM > 0 && availMonths > 0 && pctFactor > 0) {
        const needed = Math.ceil(remainPM / (availMonths * pctFactor));
        const current = Math.ceil(e.fte ?? totalResources(p));
        const extra = needed - current;
        if (extra > 0) addPeople.push({ slNo: p.rowNumber, extra, needed });
      }
      if (e.endDate.getTime() > latestEnd.getTime()) latestEnd = e.endDate;
    }
    if (addPeople.length > 0) {
      recs.push({
        color: C.heading,
        text: `To fit release: add people to ${addPeople.slice(0, 5).map(a => `Sl ${a.slNo} (+${a.extra} to ${a.needed})`).join(', ')}${addPeople.length > 5 ? '...' : ''}.`,
      });
    }
    recs.push({
      color: C.heading,
      text: `Or move target to ${formatDate(latestEnd)} to accommodate current plan.`,
    });
  } else if (longPoles.length > 0) {
    recs.push({
      color: C.green,
      text: 'Schedule fits within target date. To shorten, add people to long-pole projects or shift spare capacity earlier.',
    });
  } else {
    recs.push({
      color: C.green,
      text: 'All projects well within timeline. Healthy schedule with room for new work.',
    });
  }
  return recs;
}
