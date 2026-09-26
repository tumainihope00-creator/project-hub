import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const FORCE = process.env.FORCE === '1';

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86400000);
}

function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * 3600000);
}

async function clearAll() {
  await prisma.tagAssignment.deleteMany();
  await prisma.activityEvent.deleteMany();
  await prisma.projectRelationship.deleteMany();
  await prisma.promptGeneration.deleteMany();
  await prisma.promptVersion.deleteMany();
  await prisma.projectDocumentVersion.deleteMany();
  await prisma.gitReference.deleteMany();
  await prisma.attachment.deleteMany();
  await prisma.deployment.deleteMany();
  await prisma.productionIncident.deleteMany();
  await prisma.note.deleteMany();
  await prisma.projectDocument.deleteMany();
  await prisma.prompt.deleteMany();
  await prisma.aiSession.deleteMany();
  await prisma.developmentSession.deleteMany();
  await prisma.apiEndpoint.deleteMany();
  await prisma.databaseTable.deleteMany();
  await prisma.techStackItem.deleteMany();
  await prisma.architectureDecision.deleteMany();
  await prisma.researchQuestion.deleteMany();
  await prisma.researchEntry.deleteMany();
  await prisma.featureRequirement.deleteMany();
  await prisma.milestone.deleteMany();
  await prisma.issue.deleteMany();
  await prisma.task.deleteMany();
  await prisma.requirement.deleteMany();
  await prisma.feature.deleteMany();
  await prisma.project.deleteMany();
  await prisma.tag.deleteMany();
}

async function main() {
  const existing = await prisma.project.count();
  if (existing > 0 && !FORCE) {
    console.log(`Seed skipped: ${existing} project(s) already exist. Run FORCE=1 to reseed.`);
    return;
  }
  if (FORCE && existing > 0) await clearAll();

  // Tags
  const tagNames = ['python', 'flask', 'android', 'bluetooth', 'database', 'security', 'school', 'iot', 'web', 'react', 'nodejs', 'postgres', 'automation', 'mobile', 'network'];
  const tagIds: Record<string, number> = {};
  for (const name of tagNames) {
    const t = await prisma.tag.upsert({ where: { name }, create: { name }, update: {} });
    tagIds[name] = t.id;
  }

  async function assignTags(type: string, id: number, names: string[]) {
    for (const name of names) {
      if (!tagIds[name]) continue;
      await prisma.tagAssignment.create({ data: { tagId: tagIds[name], taggableType: type, taggableId: id } });
    }
  }

  async function stageChanged(projectId: number, from: string, to: string, when: Date) {
    await prisma.activityEvent.create({
      data: {
        projectId,
        type: 'STAGE_CHANGED',
        description: `Stage changed: ${from} → ${to}`,
        metadata: JSON.stringify({ fromStage: from, toStage: to }),
        createdAt: when
      }
    });
  }

  // =========================================================================
  // NODIA - Assignment formatting web application
  // =========================================================================
  const nodia = await prisma.project.create({
    data: {
      slug: 'nodia',
      name: 'NODIA',
      description:
        'Assignment formatting web application. Takes raw university assignment content and formats it into a clean, structurally correct document (headings, citations, references, layout) ready for submission.',
      problem: 'University assignments lose marks due to inconsistent formatting: wrong heading hierarchy, missing citations, unreadable layouts, and varying output formats between Word and PDF.',
      motivation: 'I spend too long manually formatting assignments instead of spending that time on content. A tool that standardises formatting would save hours per assignment and improve grades.',
      targetUsers: 'University students submitting written assignments.',
      expectedValue: 'Save 1-2 hours per assignment and produce consistently well-formatted submissions.',
      assumptions: 'Students are willing to paste their raw content into a web app; most assignments can be normalised into a predictable structure.',
      initialQuestions: 'Which output formats matter most? Should it support academic citations?',
      v1Scope: 'Paste assignment text in a browser, format it into clean heading structure with a bibliography, preview the result, and export it as DOCX. Citation detection, PDF export and multiple user accounts are out of scope for V1.',
      inspiration: 'Frustration with an afternoon wasted reformatting an essay in Word.',
      stage: 'BUILDING',
      createdAt: daysAgo(52),
      updatedAt: hoursAgo(26)
    }
  });
  await prisma.activityEvent.create({ data: { projectId: nodia.id, type: 'PROJECT_CREATED', description: 'Project "NODIA" created (BUILDING)', createdAt: daysAgo(52), relatedType: 'project', relatedId: nodia.id } });
  await stageChanged(nodia.id, 'IDEA', 'RESEARCH', daysAgo(48));
  await stageChanged(nodia.id, 'RESEARCH', 'PLANNING', daysAgo(40));
  await stageChanged(nodia.id, 'PLANNING', 'ARCHITECTURE', daysAgo(33));
  await stageChanged(nodia.id, 'ARCHITECTURE', 'BUILDING', daysAgo(21));
  await assignTags('project', nodia.id, ['web', 'react', 'nodejs']);

  const [fEngine] = await Promise.all([
    prisma.feature.create({ data: { projectId: nodia.id, name: 'Formatting engine', description: 'Core engine that normalises raw text into heading structure, paragraphs and lists.', status: 'BUILDING', priority: 'HIGH', createdAt: daysAgo(20) } }),
    prisma.feature.create({ data: { projectId: nodia.id, name: 'Citation manager', description: 'Detect references and format them into a bibliography.', status: 'PLANNED', priority: 'MEDIUM', createdAt: daysAgo(20) } }),
    prisma.feature.create({ data: { projectId: nodia.id, name: 'Export to DOCX & PDF', description: 'Produce downloadable documents in both formats.', status: 'PLANNED', priority: 'HIGH', createdAt: daysAgo(20) } })
  ]);

  await prisma.requirement.createMany({ data: [
    { projectId: nodia.id, code: 'FR-001', title: 'User can paste unformatted assignment text', description: 'The app accepts arbitrary pasted text via a textarea.', type: 'FUNCTIONAL', status: 'APPROVED', createdAt: daysAgo(19) },
    { projectId: nodia.id, code: 'FR-002', title: 'App detects and applies heading hierarchy', description: 'Heading levels are inferred from formatting cues.', type: 'FUNCTIONAL', status: 'APPROVED', createdAt: daysAgo(19) },
    { projectId: nodia.id, code: 'FR-003', title: 'App generates a bibliography', description: 'References are parsed into a consistent citation format.', type: 'FUNCTIONAL', status: 'IN_PROGRESS', createdAt: daysAgo(19) },
    { projectId: nodia.id, code: 'NFR-001', title: 'Formatting is fast enough for 20-page docs', description: 'Processing a 20-page document completes within a few seconds.', type: 'NON_FUNCTIONAL', status: 'APPROVED', createdAt: daysAgo(19) }
  ] });

  const r1 = await prisma.requirement.findFirst({ where: { projectId: nodia.id, code: 'FR-001' } });
  const r2 = await prisma.requirement.findFirst({ where: { projectId: nodia.id, code: 'FR-003' } });

  const nodiaTasks = [
    { title: 'Scaffold frontend with Vite + React', status: 'COMPLETED', priority: 'HIGH', created: daysAgo(19), done: daysAgo(17), reqId: r1?.id },
    { title: 'Design formatting engine input model', status: 'COMPLETED', priority: 'HIGH', created: daysAgo(16), done: daysAgo(13), reqId: r1?.id },
    { title: 'Implement heading detection heuristics', status: 'COMPLETED', priority: 'HIGH', created: daysAgo(12), done: daysAgo(9), reqId: r1?.id },
    { title: 'Build paragraph & list normaliser', status: 'IN_PROGRESS', priority: 'HIGH', created: daysAgo(8), done: null, reqId: r1?.id },
    { title: 'Browser preview pane', status: 'TODO', priority: 'MEDIUM', created: daysAgo(6), done: null, reqId: null },
    { title: 'Citation regex + bibliography generator', status: 'TODO', priority: 'MEDIUM', created: daysAgo(4), done: null, reqId: r2?.id },
    { title: 'DOCX export via docx library', status: 'TODO', priority: 'MEDIUM', created: daysAgo(2), done: null, reqId: null },
    { title: 'PDF export (print to PDF)', status: 'TODO', priority: 'LOW', created: daysAgo(2), done: null, reqId: null }
  ];

  let taskNum = 0;
  for (const t of nodiaTasks) {
    taskNum++;
    const created = await prisma.task.create({
      data: {
        projectId: nodia.id,
        code: `TASK-${String(taskNum).padStart(3, '0')}`,
        title: t.title,
        status: t.status as any,
        priority: t.priority as any,
        createdAt: t.created,
        updatedAt: t.done ?? t.created,
        completedAt: t.done,
        requirementId: t.reqId,
        featureId: fEngine.id
      }
    });
    await assignTags('task', created.id, ['web']);
    if (t.status === 'COMPLETED') {
      await prisma.activityEvent.create({ data: { projectId: nodia.id, type: 'TASK_COMPLETED', description: `Task ${created.code} completed: ${created.title}`, createdAt: t.done ?? t.created, relatedType: 'task', relatedId: created.id } });
    }
  }

  const i1 = await prisma.issue.create({ data: { projectId: nodia.id, code: 'ISSUE-001', title: 'Heading detection misses numbered headings', severity: 'MEDIUM', status: 'CLOSED', createdAt: daysAgo(12), resolvedAt: daysAgo(10), description: 'H2 headings like "2.1 Literature" are not detected.', stepsToReproduce: 'Paste a document with numbered headings, run format.', expectedBehavior: 'Numbered subheadings become headings.', actualBehavior: 'They stay paragraphs.' } });
  await prisma.activityEvent.create({ data: { projectId: nodia.id, type: 'ISSUE_RESOLVED', description: `Issue ${i1.code} resolved: ${i1.title}`, createdAt: daysAgo(10), relatedType: 'issue', relatedId: i1.id } });
  await prisma.issue.create({ data: { projectId: nodia.id, code: 'ISSUE-002', title: 'Pasted text loses paragraph breaks', severity: 'HIGH', status: 'RESOLVED', createdAt: daysAgo(6), resolvedAt: hoursAgo(20), description: 'Multi-paragraph paste collapses into single block.', stepsToReproduce: 'Paste a multi-paragraph document, click Format.', expectedBehavior: 'Paragraph structure preserved.', actualBehavior: 'Line breaks collapsed.' } });

  await prisma.developmentSession.createMany({ data: [
    { projectId: nodia.id, number: 1, date: daysAgo(17), durationMinutes: 150, goal: 'Scaffold the frontend', workedOn: 'Vite scaffold, routing, basic layout', completed: 'App shell renders, router works', problems: 'None major', learned: 'Vite defaults are fast to work with', nextStep: 'Design formatting engine' },
    { projectId: nodia.id, number: 2, date: daysAgo(9), durationMinutes: 120, goal: 'Implement heading detection', workedOn: 'Heuristics for heading levels based on formatting cues', completed: 'Detects simple numbered headings', problems: 'Uppercase lines misdetected as headings', learned: 'Set a confidence threshold', nextStep: 'Paragraph normaliser' }
  ] });

  await prisma.aiSession.createMany({ data: [
    { projectId: nodia.id, number: 1, tool: 'Claude Code', date: daysAgo(17), purpose: 'Scaffold React + TypeScript app', promptText: 'Set up a Vite React TS project with React Router for NODIA.', responseText: 'Generated project with Vite scaffold.', usedFromAI: 'Scaffold structure', rejectedFromAI: 'Proposed UI library', changesMade: 'Switched to plain CSS', result: 'SUCCESSFUL' },
    { projectId: nodia.id, number: 2, tool: 'ChatGPT', date: daysAgo(9), purpose: 'Heading detection algorithm', promptText: 'How to detect heading levels from pasted Word-formatted text in JS?', responseText: 'Suggested regex + font-size heuristics.', usedFromAI: 'Confidence threshold idea', rejectedFromAI: 'Full ML approach', changesMade: 'Implemented simple heuristic scorer', result: 'PARTIALLY_SUCCESSFUL' }
  ] });

  const p1 = await prisma.prompt.create({ data: { projectId: nodia.id, code: 'PROMPT-001', title: 'Scaffold NODIA frontend', category: 'Coding', stage: 'BUILDING', tool: 'Claude Code', date: daysAgo(17), purpose: 'Create the initial app shell', result: 'SUCCESSFUL', resultNote: 'Worked first try.' } });
  const v1 = await prisma.promptVersion.create({ data: { promptId: p1.id, version: 1, text: 'Create a Vite React TypeScript project called NODIA with React Router and a minimal developer-tool layout.', response: 'Generated scaffold with clear structure.' } });
  await prisma.prompt.update({ where: { id: p1.id }, data: { finalVersionId: v1.id } });
  await assignTags('prompt', p1.id, ['web']);

  const p2 = await prisma.prompt.create({ data: { projectId: nodia.id, code: 'PROMPT-002', title: 'Heading detection heuristics', category: 'Coding', stage: 'BUILDING', tool: 'ChatGPT', date: daysAgo(9), purpose: 'Detect headings from formatted text', result: 'PARTIALLY_SUCCESSFUL', resultNote: 'AI assumed DOM input; actual input is raw text. Fixed by sending the real input model.' } });
  const v2 = await prisma.promptVersion.create({ data: { promptId: p2.id, version: 1, text: 'Write JS to detect heading levels from pasted text maintaining formatting markers.', response: 'Suggested measuring rendered font size — not applicable to raw text.' } });
  const v2b = await prisma.promptVersion.create({ data: { promptId: p2.id, version: 2, text: 'Given a plain-text structure with formatting cues (e.g. "##Title"), score each line as a heading candidate.', response: 'Heuristic scorer with threshold.', changes: 'Provided actual input format.', reason: 'First version assumed DOM access.', isFinal: true } });
  await prisma.prompt.update({ where: { id: p2.id }, data: { finalVersionId: v2b.id } });
  await assignTags('prompt', p2.id, ['web']);

  const researchDocs = await prisma.researchEntry.createMany({ data: [
    { projectId: nodia.id, title: 'How academia enforces formatting', type: 'MARKET', summary: 'Most formatting guidance is checklist-based.', findings: 'No dominant automated tool; Word still dominates.', relevance: 'High', date: daysAgo(46) },
    { projectId: nodia.id, title: 'docx library capabilities', type: 'TECHNICAL', summary: 'Can generate .docx in-browser.', findings: 'docx JS lib is browser-compatible.', relevance: 'High', date: daysAgo(30) }
  ] });
  const rEntry = await prisma.researchEntry.findFirst({ where: { projectId: nodia.id, title: { contains: 'docx' } } });
  await prisma.activityEvent.create({ data: { projectId: nodia.id, type: 'RESEARCH_ADDED', description: 'Research added: docx library capabilities', createdAt: daysAgo(30), relatedType: 'researchEntry', relatedId: rEntry!.id } });
  await assignTags('research', rEntry!.id, ['web']);

  await prisma.architectureDecision.createMany({ data: [
    { projectId: nodia.id, code: 'ADR-001', title: 'Use in-browser DOCX generation', decision: 'Generate DOCX client-side with the docx library instead of server-side.', context: 'Formatting is pure text transformation; no sensitive data.', alternatives: JSON.stringify(['Server-side Pandoc', 'Client-side docx', 'Docx templates']), reasoning: 'Zero server cost, no PDF pipeline to maintain, works offline.', consequences: 'Larger client bundle; complex layouts may need server later.', status: 'ACCEPTED', createdAt: daysAgo(32) },
    { projectId: nodia.id, code: 'ADR-002', title: 'Plain-text input model with formatting cues', decision: 'Parser produces a marked-up structure instead of relying on the browser DOM.', context: 'Users paste from Word, Google Docs and plain text.', alternatives: JSON.stringify(['Live DOM editing', 'Markdown input', 'Cue-based parser']), reasoning: 'Most faithful across mixed sources.', consequences: 'Custom parser to maintain.', status: 'ACCEPTED', createdAt: daysAgo(29) }
  ] });

  await prisma.milestone.createMany({ data: [
    { projectId: nodia.id, name: 'MVP', description: 'Format + preview a pasted document.', targetDate: daysAgo(-10), status: 'IN_PROGRESS', createdAt: daysAgo(30) },
    { projectId: nodia.id, name: 'Version 1.0', description: 'Exports + citation manager.', targetDate: daysAgo(30), status: 'PLANNED', createdAt: daysAgo(30) }
  ] });

  await prisma.productionIncident.create({ data: { projectId: nodia.id, title: 'Preview freezes on 20-page documents', severity: 'HIGH', status: 'RESOLVED', startedAt: daysAgo(5), resolvedAt: daysAgo(4), resolution: 'Debounced parser runs off the main thread.' } });

  const doc1 = await prisma.projectDocument.create({ data: { projectId: nodia.id, type: 'README', title: 'NODIA README', currentVersion: 1, createdAt: daysAgo(15) } });
  await prisma.projectDocumentVersion.create({ data: { documentId: doc1.id, version: 1, title: 'NODIA README', content: '# NODIA\n\nAssignment formatting web application.\n\n## Status\n\nBuilding.' } });
  const doc2 = await prisma.projectDocument.create({ data: { projectId: nodia.id, type: 'ARCHITECTURE_DOCUMENTATION', title: 'Formatting pipeline', currentVersion: 1, createdAt: daysAgo(14) } });
  await prisma.projectDocumentVersion.create({ data: { documentId: doc2.id, version: 1, title: 'Formatting pipeline', content: '# Pipeline\n\n1. Parse raw text into cue structure\n2. Score heading candidates\n3. Normalise paragraphs\n4. Render preview' } });

  await prisma.note.create({ data: { projectId: nodia.id, title: 'Ideas for citation UX', content: 'Maybe let users highlight text to mark it as a citation reference directly in the preview.', createdAt: daysAgo(7) } });
  await prisma.deployment.create({ data: { projectId: nodia.id, environment: 'DEVELOPMENT', version: '0.1.0', platform: 'Vercel', url: 'https://nodia-dev.vercel.app', commitHash: 'a83f19c', branch: 'main', date: daysAgo(6), status: 'SUCCESSFUL' } });
  await prisma.gitReference.create({ data: { projectId: nodia.id, kind: 'COMMIT', commitHash: 'a83f19c', commitMessage: 'Implement paragraph normaliser', branch: 'main', date: daysAgo(7) } });

  // =========================================================================
  // NODEN - University-email notification / overlay concept
  // =========================================================================
  const noden = await prisma.project.create({
    data: {
      slug: 'noden',
      name: 'NODEN',
      description: 'University-email notification/overlay concept. A lightweight tray/overlay app that watches a university email inbox and surfaces important notices over the desktop without opening the mail client.',
      problem: 'Important university emails (deadlines, room changes, cancellations) get buried in the inbox and are missed.',
      motivation: 'Missed a deadline announcement buried under a hundred marketing emails; wanted a watcher that pops notable mail.',
      targetUsers: 'Students relying on university email for time-sensitive notices.',
      expectedValue: 'Fewer missed notices; faster reaction to schedule changes.',
      assumptions: 'Users are comfortable authorising inbox access; filters can separate real notices from marketing mail.',
      initialQuestions: 'Which mailbox APIs can we use? Can notifications run without a persistent app open?',
      inspiration: 'Missed a room-change email 20 minutes before a lecture.',
      stage: 'RESEARCH',
      createdAt: daysAgo(14),
      updatedAt: hoursAgo(30)
    }
  });
  await prisma.activityEvent.create({ data: { projectId: noden.id, type: 'PROJECT_CREATED', description: 'Project "NODEN" created (RESEARCH)', createdAt: daysAgo(14), relatedType: 'project', relatedId: noden.id } });
  await assignTags('project', noden.id, ['automation', 'mobile', 'security']);

  await prisma.researchEntry.createMany({ data: [
    { projectId: noden.id, title: 'Gmail API scope & quota', type: 'TECHNICAL', source: 'Google', url: 'https://developers.google.com/gmail/api', summary: 'IMAP read is simpler and quota-free.', findings: 'IMAP IDLE can push new-mail events.', relevance: 'High', date: daysAgo(12) },
    { projectId: noden.id, title: 'Offline behaviour feasibility', type: 'TECHNICAL', summary: 'A local watcher can run regardless of connectivity.', findings: 'Needs a local daemon; a web-only approach will not work.', relevance: 'Medium', date: daysAgo(10) }
  ] });

  await prisma.researchQuestion.createMany({ data: [
    { projectId: noden.id, question: 'How should authentication work?', status: 'INVESTIGATING', category: 'Security', createdAt: daysAgo(11) },
    { projectId: noden.id, question: 'Can this work offline?', answer: 'A local watcher daemon can because it polls IMAP directly.', status: 'ANSWERED', category: 'Technical', createdAt: daysAgo(11), updatedAt: daysAgo(9) },
    { projectId: noden.id, question: 'How should notification severity be ranked?', status: 'OPEN', category: 'UX', createdAt: daysAgo(9) }
  ] });

  await prisma.note.create({ data: { projectId: noden.id, title: 'Tray vs overlay', content: 'Overlay could steal focus on Windows; tray balloon + toast is safer. Decide during planning.', createdAt: daysAgo(6) } });

  // =========================================================================
  // NOMAD - location-aware personal dashboard idea
  // =========================================================================
  const nomad = await prisma.project.create({
    data: {
      slug: 'nomad',
      name: 'NOMAD',
      description: 'Idea for a location-aware personal dashboard that surfaces contextually relevant reminders based on where you are (campus, home, transit).',
      problem: 'Reminders are time-based only; context such as "when I am on campus" is valuable for student workflows.',
      motivation: 'Wanted reminders like "grab lab report when you pass the print shop".',
      targetUsers: 'Students and commuters with repetitive location patterns.',
      initialQuestions: 'Privacy of location data? Battery impact of geofencing?',
      inspiration: 'Missed a print job while already at the lab.',
      stage: 'IDEA',
      createdAt: daysAgo(60),
      updatedAt: daysAgo(3)
    }
  });
  await prisma.activityEvent.create({ data: { projectId: nomad.id, type: 'PROJECT_CREATED', description: 'Project "NOMAD" created (IDEA)', createdAt: daysAgo(60), relatedType: 'project', relatedId: nomad.id } });
  await assignTags('project', nomad.id, ['mobile', 'iot']);

  await prisma.researchQuestion.createMany({ data: [
    { projectId: nomad.id, question: 'How accurate does geofencing need to be?', status: 'OPEN', category: 'Technical', createdAt: daysAgo(55) },
    { projectId: nomad.id, question: 'Would users find location reminders useful?', status: 'INVESTIGATING', category: 'User', createdAt: daysAgo(54) }
  ] });

  // =========================================================================
  // WiFi Attendance
  // =========================================================================
  const wifi = await prisma.project.create({
    data: {
      slug: 'wifi-attendance',
      name: 'WiFi Attendance',
      description: 'Attendance tracking by detecting which classroom/club WiFi network a device is connected to at session time.',
      problem: 'Manual attendance rolls are error-prone and time-consuming for clubs and small classes.',
      motivation: 'A single "connected to this network = present" signal is cheap and unobtrusive.',
      targetUsers: 'Club leads, lecturers, workshop organisers.',
      expectedValue: 'Automatic, verified attendance lists.',
      assumptions: 'Devices auto-join known networks; one device per person.',
      initialQuestions: 'Can people be present without being on the network? How to prevent spoofing?',
      stage: 'PLANNING',
      createdAt: daysAgo(90),
      updatedAt: daysAgo(1)
    }
  });
  await prisma.activityEvent.create({ data: { projectId: wifi.id, type: 'PROJECT_CREATED', description: 'Project "WiFi Attendance" created (PLANNING)', createdAt: daysAgo(90), relatedType: 'project', relatedId: wifi.id } });
  await stageChanged(wifi.id, 'IDEA', 'RESEARCH', daysAgo(85));
  await stageChanged(wifi.id, 'RESEARCH', 'PLANNING', daysAgo(70));
  await assignTags('project', wifi.id, ['network', 'python', 'security']);

  await prisma.researchEntry.createMany({ data: [
    { projectId: wifi.id, title: 'WiFi presence detection accuracy', type: 'TECHNICAL', summary: 'Network signal alone can false-positive.', findings: 'Cross-check with the ARP/IP lease table.', relevance: 'High', date: daysAgo(80) },
    { projectId: wifi.id, title: 'Spoofing & privacy concerns', type: 'SECURITY', summary: 'MAC randomisation reduces passive reliability.', findings: 'Privacy-friendly: use an opt-in app instead of passive sniffing.', relevance: 'High', date: daysAgo(74) }
  ] });

  await prisma.requirement.createMany({ data: [
    { projectId: wifi.id, code: 'FR-001', title: 'List members present per session', description: 'Group members seen on the network during the session window are marked present.', type: 'FUNCTIONAL', status: 'PROPOSED', createdAt: daysAgo(60) },
    { projectId: wifi.id, code: 'NFR-001', title: 'Session data must be private', description: 'Location/time data not exposed outside the group.', type: 'NON_FUNCTIONAL', status: 'PROPOSED', createdAt: daysAgo(60) }
  ] });

  await prisma.architectureDecision.create({ data: { projectId: wifi.id, code: 'ADR-001', title: 'Opt-in app over passive sniffing', decision: 'Use an opt-in client app that reports network SSID.', context: 'Passive sniffing raises privacy and accuracy issues.', alternatives: JSON.stringify(['Passive ARP/lease sniffing', 'Opt-in mobile app reporting SSID']), reasoning: 'Privacy-safe and more accurate.', consequences: 'Users must install an app.', status: 'ACCEPTED', createdAt: daysAgo(68) } });

  // =========================================================================
  // Lost & Found  +  Library Laptop Tracking  (related projects)
  // =========================================================================
  const lost = await prisma.project.create({
    data: {
      slug: 'lost-found',
      name: 'Lost & Found',
      description: 'Centralised campus lost-and-found registry: report lost or found items, match by description/location, and coordinate handover.',
      problem: 'Lost property is reported to scattered desks with no shared registry, so matching is rare.',
      motivation: 'A friend lost a laptop and the search was entirely manual across six offices.',
      targetUsers: 'Campus security, students, staff.',
      expectedValue: 'More items reunited and a record of the process.',
      assumptions: 'People report items; matching heuristics work with partial descriptions.',
      initialQuestions: 'Which attributes make matching reliable? Who moderates?',
      stage: 'RESEARCH',
      createdAt: daysAgo(35),
      updatedAt: hoursAgo(6)
    }
  });
  await prisma.activityEvent.create({ data: { projectId: lost.id, type: 'PROJECT_CREATED', description: 'Project "Lost & Found" created (RESEARCH)', createdAt: daysAgo(35), relatedType: 'project', relatedId: lost.id } });
  await assignTags('project', lost.id, ['school', 'database']);

  const laptop = await prisma.project.create({
    data: {
      slug: 'library-laptop-tracking',
      name: 'Library Laptop Tracking',
      description: 'Sensor/tag-based tracking of laptops loaned from the university library so lost units are found quickly and loans are auditable.',
      problem: 'Loaned laptops frequently leave the library building and are hard to locate at return stations.',
      motivation: 'The library counts dozens of missing units per term.',
      targetUsers: 'Library staff, IT support.',
      expectedValue: 'Locate missing laptops in minutes instead of days.',
      assumptions: 'Tags and readers already deployed in the building.',
      stage: 'IDEA',
      createdAt: daysAgo(20),
      updatedAt: daysAgo(2)
    }
  });
  await prisma.activityEvent.create({ data: { projectId: laptop.id, type: 'PROJECT_CREATED', description: 'Project "Library Laptop Tracking" created (IDEA)', createdAt: daysAgo(20), relatedType: 'project', relatedId: laptop.id } });
  await assignTags('project', laptop.id, ['iot']);

  await prisma.projectRelationship.create({ data: { fromProjectId: lost.id, toProjectId: laptop.id, type: 'INSPIRED_BY', notes: 'Nearby problem space; a shared registry would list tagged laptops.' } });
  await prisma.activityEvent.create({ data: { projectId: lost.id, type: 'RELATIONSHIP_CREATED', description: 'Related "Lost & Found" → "Library Laptop Tracking" (INSPIRED_BY)', createdAt: daysAgo(19), relatedType: 'projectRelationship', relatedId: 0 } });

  await prisma.researchEntry.create({ data: { projectId: lost.id, title: 'Campus security workflows', type: 'USER', summary: 'Offices keep paper logs.', findings: 'A digital registry would centralise matching.', relevance: 'High', date: daysAgo(30) } });
  await prisma.note.create({ data: { projectId: laptop.id, title: 'Existing infra', content: 'The library already runs RFID readers at two doors — reuse, do not rebuild.', createdAt: daysAgo(4) } });

  console.log('Seed complete.', {
    projects: await prisma.project.count(),
    tasks: await prisma.task.count(),
    issues: await prisma.issue.count(),
    prompts: await prisma.prompt.count(),
    research: await prisma.researchEntry.count(),
    activity: await prisma.activityEvent.count(),
    relationships: await prisma.projectRelationship.count()
  });
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());