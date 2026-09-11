const SLOTS = [
  "10:00–13:00",
  "13:00–16:00",
  "16:00–19:00",
  "19:00–22:00",
];

const ACTIVITY_TYPES = new Set(["work", "study", "leisure", "health", "communication", "household"]);
const CATEGORY_LABELS = {
  work: "Работа",
  study: "Учёба",
  leisure: "Досуг",
  health: "Здоровье",
  communication: "Общение",
  household: "Быт",
};

const DB_NAME = "day-planner-db";
const DB_VERSION = 2;
const DAY_STORE = "days";
const TASK_STORE = "tasks";

const dom = {
  calendarView: document.querySelector("#calendarView"),
  remindersView: document.querySelector("#remindersView"),
  navCalendarBtn: document.querySelector("#navCalendarBtn"),
  navRemindersBtn: document.querySelector("#navRemindersBtn"),

  monthTitle: document.querySelector("#monthTitle"),
  calendarGrid: document.querySelector("#calendarGrid"),
  selectedDateTitle: document.querySelector("#selectedDateTitle"),
  selectedWeekday: document.querySelector("#selectedWeekday"),
  timeBlocks: document.querySelector("#timeBlocks"),
  slotTemplate: document.querySelector("#slotTemplate"),
  saveStatus: document.querySelector("#saveStatus"),

  queueTabBtn: document.querySelector("#queueTabBtn"),
  scheduledTabBtn: document.querySelector("#scheduledTabBtn"),
  queuePanel: document.querySelector("#queuePanel"),
  scheduledPanel: document.querySelector("#scheduledPanel"),
  queueList: document.querySelector("#queueList"),
  queueEmpty: document.querySelector("#queueEmpty"),
  addQueueTaskBtn: document.querySelector("#addQueueTaskBtn"),

  scheduledDateTitle: document.querySelector("#scheduledDateTitle"),
  scheduledWeekday: document.querySelector("#scheduledWeekday"),
  scheduledBlocks: document.querySelector("#scheduledBlocks"),
  scheduledEmpty: document.querySelector("#scheduledEmpty"),

  taskDialog: document.querySelector("#taskDialog"),
  taskForm: document.querySelector("#taskForm"),
  taskDialogTitle: document.querySelector("#taskDialogTitle"),
  taskTitleInput: document.querySelector("#taskTitleInput"),
  taskNoteInput: document.querySelector("#taskNoteInput"),
  taskImportantToggle: document.querySelector("#taskImportantToggle"),
  taskUrgentToggle: document.querySelector("#taskUrgentToggle"),

  scheduleDialog: document.querySelector("#scheduleDialog"),
  scheduleForm: document.querySelector("#scheduleForm"),
  scheduleTaskName: document.querySelector("#scheduleTaskName"),
  scheduleDateInput: document.querySelector("#scheduleDateInput"),
  scheduleSlotChoices: document.querySelector("#scheduleSlotChoices"),
  scheduleNoSlots: document.querySelector("#scheduleNoSlots"),
  confirmScheduleBtn: document.querySelector("#confirmScheduleBtn"),
  openScheduleDateInCalendarBtn: document.querySelector("#openScheduleDateInCalendarBtn"),

  toast: document.querySelector("#toast"),
};

let selectedDate = startOfDay(new Date());
let currentMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
let scheduledDate = startOfDay(new Date());
let monthRecords = new Map();
let allTasks = [];
let saveTimer = null;
let dbPromise = null;
let editingTaskId = null;
let taskPresetSchedule = null;
let schedulingTaskId = null;
let toastTimer = null;
let dragState = null;
let activeMainView = "calendar";
let activeReminderTab = "scheduled";
const scrollPositions = { calendar: 0, queue: 0, scheduled: 0 };
const collapsedScheduledBlocks = new Set();

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseDateKey(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function sameDate(a, b) {
  return dateKey(a) === dateKey(b);
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function emptyDay(date) {
  const slots = {};
  for (const interval of SLOTS) {
    slots[interval] = { category: "", start: "", note: "" };
  }
  return { date: dateKey(date), slots, updatedAt: Date.now() };
}

function normalizeRecord(record, date) {
  const base = emptyDay(date);
  if (!record) return base;

  for (const interval of SLOTS) {
    base.slots[interval] = {
      ...base.slots[interval],
      ...(record.slots?.[interval] ?? {}),
    };
  }
  return { ...base, ...record, slots: base.slots };
}

function normalizeTask(task) {
  return {
    id: task.id,
    title: task.title ?? "",
    note: task.note ?? "",
    important: Boolean(task.important),
    urgent: Boolean(task.urgent),
    completed: Boolean(task.completed),
    order: Number.isFinite(task.order) ? task.order : Date.now(),
    scheduled: task.scheduled?.date && SLOTS.includes(task.scheduled?.slot)
      ? { date: task.scheduled.date, slot: task.scheduled.slot }
      : null,
    createdAt: task.createdAt ?? Date.now(),
    updatedAt: task.updatedAt ?? Date.now(),
  };
}

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DAY_STORE)) {
        db.createObjectStore(DAY_STORE, { keyPath: "date" });
      }
      if (!db.objectStoreNames.contains(TASK_STORE)) {
        db.createObjectStore(TASK_STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

async function requestResult(storeName, mode, operation) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let request;

    try {
      request = operation(store);
    } catch (error) {
      reject(error);
      return;
    }

    if (request) {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    } else {
      tx.oncomplete = () => resolve();
    }

    tx.onerror = () => reject(tx.error);
  });
}

function getDay(key) {
  return requestResult(DAY_STORE, "readonly", store => store.get(key));
}

function putDay(record) {
  return requestResult(DAY_STORE, "readwrite", store => store.put(record));
}

function getAllDays() {
  return requestResult(DAY_STORE, "readonly", store => store.getAll());
}

function getAllTasks() {
  return requestResult(TASK_STORE, "readonly", store => store.getAll());
}

function putTask(task) {
  return requestResult(TASK_STORE, "readwrite", store => store.put(task));
}

function deleteTaskRecord(id) {
  return requestResult(TASK_STORE, "readwrite", store => store.delete(id));
}

function monthLabel(date) {
  const text = new Intl.DateTimeFormat("ru-RU", {
    month: "long",
    year: "numeric",
  }).format(date);
  return text[0].toUpperCase() + text.slice(1);
}

function selectedDateLabel(date) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function weekdayLabel(date) {
  const text = new Intl.DateTimeFormat("ru-RU", { weekday: "long" }).format(date);
  return text[0].toUpperCase() + text.slice(1);
}

function dotCategoriesForRecord(record) {
  if (!record?.slots) return [];
  return SLOTS
    .map(interval => record.slots[interval]?.category)
    .filter(category => ACTIVITY_TYPES.has(category));
}

function taskDisplayOrder(a, b) {
  // Completed tasks always form the second group. Manual order is preserved
  // independently inside unfinished and completed groups.
  return Number(a.completed) - Number(b.completed)
    || a.order - b.order
    || a.createdAt - b.createdAt;
}

function queueTasks() {
  return allTasks
    .filter(task => !task.scheduled)
    .sort(taskDisplayOrder);
}

function tasksForSchedule(date, slot = null) {
  const key = typeof date === "string" ? date : dateKey(date);
  return allTasks
    .filter(task => task.scheduled?.date === key && (!slot || task.scheduled.slot === slot))
    .sort(taskDisplayOrder);
}

async function refreshData() {
  const [days, tasks] = await Promise.all([getAllDays(), getAllTasks()]);
  monthRecords = new Map(days.map(item => [item.date, item]));
  allTasks = tasks.map(normalizeTask);
}

function renderCalendar() {
  dom.monthTitle.textContent = monthLabel(currentMonth);
  dom.calendarGrid.innerHTML = "";

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const first = new Date(year, month, 1);
  const mondayIndex = (first.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - mondayIndex);

  for (let i = 0; i < 42; i++) {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + i);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "day-cell";
    btn.dataset.date = dateKey(day);

    if (day.getMonth() !== month) btn.classList.add("outside");
    if (sameDate(day, new Date())) btn.classList.add("today");
    if (sameDate(day, selectedDate)) btn.classList.add("selected");

    const number = document.createElement("span");
    number.className = "day-number";
    number.textContent = day.getDate();

    const dots = document.createElement("span");
    dots.className = "day-dots";

    for (const category of dotCategoriesForRecord(monthRecords.get(dateKey(day)))) {
      const dot = document.createElement("span");
      dot.className = `day-dot ${category}`;
      dots.appendChild(dot);
    }

    btn.append(number, dots);
    btn.addEventListener("click", async () => {
      selectedDate = startOfDay(day);
      if (selectedDate.getMonth() !== currentMonth.getMonth() || selectedDate.getFullYear() !== currentMonth.getFullYear()) {
        currentMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
      }
      renderCalendar();
      await renderPlanner();
    });

    dom.calendarGrid.appendChild(btn);
  }
}

async function renderPlanner() {
  dom.selectedDateTitle.textContent = selectedDateLabel(selectedDate);
  dom.selectedWeekday.textContent = weekdayLabel(selectedDate);

  const record = normalizeRecord(await getDay(dateKey(selectedDate)), selectedDate);
  dom.timeBlocks.innerHTML = "";

  for (const interval of SLOTS) {
    const fragment = dom.slotTemplate.content.cloneNode(true);
    const slot = fragment.querySelector(".slot");
    const intervalEl = fragment.querySelector(".slot-interval");
    const categorySelect = fragment.querySelector(".category-select");
    const startInput = fragment.querySelector(".start-input");
    const noteInput = fragment.querySelector(".note-input");
    const clearBtn = fragment.querySelector(".clear-btn");
    const taskSummary = fragment.querySelector(".slot-task-summary");

    intervalEl.textContent = interval;
    categorySelect.value = record.slots[interval].category;
    startInput.value = record.slots[interval].start;
    noteInput.value = record.slots[interval].note;
    slot.dataset.interval = interval;
    slot.dataset.category = record.slots[interval].category;

    const linkedTasks = tasksForSchedule(dateKey(selectedDate), interval);
    if (linkedTasks.length) {
      const completed = linkedTasks.filter(task => task.completed).length;
      taskSummary.hidden = false;
      taskSummary.textContent = `Задачи: ${completed}/${linkedTasks.length} выполнено`;
    }

    const onEdit = () => {
      slot.dataset.category = categorySelect.value;
      scheduleDaySave();
    };

    categorySelect.addEventListener("change", onEdit);
    startInput.addEventListener("input", onEdit);
    noteInput.addEventListener("input", onEdit);

    clearBtn.addEventListener("click", async () => {
      const linked = tasksForSchedule(dateKey(selectedDate), interval);
      if (linked.length) {
        const shouldClear = window.confirm(`В этом блоке ${linked.length} задач(и). Очистить блок и вернуть задачи в Очередь?`);
        if (!shouldClear) return;

        for (const task of linked) {
          task.scheduled = null;
          task.order = nextQueueOrder();
          task.updatedAt = Date.now();
          await putTask(task);
        }
        await refreshTasksOnly();
      }

      categorySelect.value = "";
      startInput.value = "";
      noteInput.value = "";
      slot.dataset.category = "";
      taskSummary.hidden = true;
      scheduleDaySave(0);
    });

    dom.timeBlocks.appendChild(fragment);
  }
}

function collectCurrentRecord() {
  const record = emptyDay(selectedDate);
  for (const slot of dom.timeBlocks.querySelectorAll(".slot")) {
    const interval = slot.dataset.interval;
    record.slots[interval] = {
      category: slot.querySelector(".category-select").value,
      start: slot.querySelector(".start-input").value,
      note: slot.querySelector(".note-input").value.trim(),
    };
  }
  record.updatedAt = Date.now();
  return record;
}

function scheduleDaySave(delay = 450) {
  clearTimeout(saveTimer);
  dom.saveStatus.textContent = "Сохраняю…";
  dom.saveStatus.classList.add("saving");

  saveTimer = setTimeout(async () => {
    const record = collectCurrentRecord();
    await putDay(record);
    monthRecords.set(record.date, record);
    dom.saveStatus.textContent = "Сохранено локально";
    dom.saveStatus.classList.remove("saving");
    renderCalendar();
  }, delay);
}

function renderQueue() {
  const tasks = queueTasks();
  dom.queueList.innerHTML = "";
  dom.queueEmpty.hidden = tasks.length > 0;

  for (const task of tasks) {
    dom.queueList.appendChild(createQueueTaskCard(task));
  }
}

function createQueueTaskCard(task) {
  const card = document.createElement("article");
  card.className = `queue-task task-card${task.completed ? " completed" : ""}`;
  card.dataset.taskId = task.id;

  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "drag-handle";
  handle.setAttribute("aria-label", "Перетащить задачу");
  handle.title = "Перетащить";
  handle.innerHTML = "<span>⠿</span>";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "task-checkbox";
  checkbox.checked = task.completed;
  checkbox.setAttribute("aria-label", "Отметить задачу выполненной");
  checkbox.addEventListener("change", () => toggleTaskCompleted(task.id, checkbox.checked));

  const content = document.createElement("div");
  content.className = "task-content";

  const title = document.createElement("button");
  title.type = "button";
  title.className = "task-title-button";
  title.textContent = task.title;
  title.addEventListener("click", () => openTaskDialog(task.id));

  content.appendChild(title);

  if (task.note) {
    const note = document.createElement("p");
    note.className = "task-note";
    note.textContent = task.note;
    content.appendChild(note);
  }

  const toggles = document.createElement("div");
  toggles.className = "task-priority-row";
  toggles.append(
    priorityButton(task, "important"),
    priorityButton(task, "urgent"),
  );
  content.appendChild(toggles);

  const menuBtn = document.createElement("button");
  menuBtn.type = "button";
  menuBtn.className = "more-btn small";
  menuBtn.textContent = "⋮";
  menuBtn.setAttribute("aria-label", "Действия с задачей");
  menuBtn.addEventListener("click", event => openTaskMenu(event.currentTarget, task));

  card.append(handle, checkbox, content, menuBtn);
  attachDragHandlers(handle, card);
  return card;
}

function priorityButton(task, prop) {
  const active = Boolean(task[prop]);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `priority-chip ${prop}${active ? " active" : ""}`;
  btn.textContent = priorityLabel(prop, active);
  btn.setAttribute("aria-pressed", String(active));
  btn.addEventListener("click", async () => {
    task[prop] = !task[prop];
    task.updatedAt = Date.now();
    await putTask(task);
    await refreshTasksOnly();
    renderQueue();
  });
  return btn;
}

function priorityLabel(prop, active) {
  if (prop === "important") return active ? "Важно" : "Неважно";
  return active ? "Срочно" : "Несрочно";
}

function attachDragHandlers(handle, card) {
  handle.addEventListener("pointerdown", event => {
    if (dragState) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();

    const rect = card.getBoundingClientRect();
    const placeholder = document.createElement("div");
    placeholder.className = "queue-drag-placeholder";
    placeholder.style.height = `${rect.height}px`;
    card.after(placeholder);

    dragState = {
      card,
      handle,
      placeholder,
      pointerId: event.pointerId,
      offsetY: event.clientY - rect.top,
      left: rect.left,
      width: rect.width,
    };

    // Move the preview to <body>, just like Scheduled. The reminders card
    // uses backdrop-filter, which can otherwise create a fixed-position
    // containing block in Firefox/WebKit and make the card jump.
    card.classList.add("dragging", "dragging-fixed");
    card.style.left = `${rect.left}px`;
    card.style.top = `${rect.top}px`;
    card.style.width = `${rect.width}px`;
    card.style.height = `${rect.height}px`;
    document.body.appendChild(card);
    document.body.classList.add("queue-drag-active");

    document.addEventListener("pointermove", onQueueDragMove, { capture: true, passive: false });
    document.addEventListener("pointerup", finishQueueDrag, { capture: true, passive: false });
    document.addEventListener("pointercancel", finishQueueDrag, { capture: true, passive: false });
  });
}

function onQueueDragMove(event) {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  event.preventDefault();

  const { card, placeholder, offsetY } = dragState;
  card.style.top = `${event.clientY - offsetY}px`;

  const edge = 72;
  if (event.clientY < edge) window.scrollBy(0, -12);
  else if (event.clientY > window.innerHeight - edge) window.scrollBy(0, 12);

  const draggedCompleted = card.classList.contains("completed");
  const allCandidates = [...dom.queueList.querySelectorAll(".queue-task")].filter(item => item !== card);
  const candidates = allCandidates.filter(item => item.classList.contains("completed") === draggedCompleted);
  const before = candidates.find(item => {
    const rect = item.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2;
  });

  if (before) {
    dom.queueList.insertBefore(placeholder, before);
  } else if (draggedCompleted) {
    dom.queueList.appendChild(placeholder);
  } else {
    const firstCompleted = allCandidates.find(item => item.classList.contains("completed"));
    if (firstCompleted) dom.queueList.insertBefore(placeholder, firstCompleted);
    else dom.queueList.appendChild(placeholder);
  }
}

async function finishQueueDrag(event) {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  event.preventDefault();

  const { card, placeholder } = dragState;
  document.removeEventListener("pointermove", onQueueDragMove, true);
  document.removeEventListener("pointerup", finishQueueDrag, true);
  document.removeEventListener("pointercancel", finishQueueDrag, true);

  card.classList.remove("dragging", "dragging-fixed");
  card.style.left = "";
  card.style.top = "";
  card.style.width = "";
  card.style.height = "";
  document.body.classList.remove("queue-drag-active");

  placeholder.replaceWith(card);
  dragState = null;
  await persistQueueOrderFromDOM();
}

async function persistQueueOrderFromDOM() {
  const ids = [...dom.queueList.querySelectorAll(".queue-task")].map(card => card.dataset.taskId);
  const byId = new Map(allTasks.map(task => [task.id, task]));

  await Promise.all(ids.map((id, index) => {
    const task = byId.get(id);
    if (!task) return Promise.resolve();
    task.order = index;
    task.updatedAt = Date.now();
    return putTask(task);
  }));

  await refreshTasksOnly();
  renderQueue();
}

function renderScheduled() {
  dom.scheduledDateTitle.textContent = selectedDateLabel(scheduledDate);
  dom.scheduledWeekday.textContent = weekdayLabel(scheduledDate);
  dom.scheduledBlocks.innerHTML = "";

  const key = dateKey(scheduledDate);
  const day = normalizeRecord(monthRecords.get(key), scheduledDate);
  const configuredSlots = SLOTS.filter(slot => ACTIVITY_TYPES.has(day.slots[slot]?.category));
  const dayTasks = tasksForSchedule(key);

  dom.scheduledEmpty.hidden = configuredSlots.length > 0 || dayTasks.length > 0;

  for (const interval of configuredSlots) {
    const block = createScheduledBlock(day, interval, tasksForSchedule(key, interval));
    dom.scheduledBlocks.appendChild(block);
  }

  // Safety: if a task somehow points to a block that was removed in an older version,
  // show it instead of hiding data.
  const orphanSlots = [...new Set(dayTasks.map(task => task.scheduled.slot))]
    .filter(slot => !configuredSlots.includes(slot));

  for (const interval of orphanSlots) {
    dom.scheduledBlocks.appendChild(createScheduledBlock(day, interval, tasksForSchedule(key, interval), true));
  }
}

function createScheduledBlock(day, interval, tasks, orphan = false) {
  const slot = day.slots[interval] ?? { category: "", start: "", note: "" };
  const category = slot.category;

  const article = document.createElement("article");
  article.className = "scheduled-block";
  article.dataset.category = ACTIVITY_TYPES.has(category) ? category : "neutral";
  article.dataset.slot = interval;
  article.dataset.date = day.date;
  article.dataset.orphan = String(orphan);

  const header = document.createElement("header");
  header.className = "scheduled-block-header";

  const heading = document.createElement("div");
  heading.className = "scheduled-block-heading";
  const title = document.createElement("h3");
  title.textContent = `${interval} · ${CATEGORY_LABELS[category] ?? "Без типа"}`;
  const meta = document.createElement("p");
  meta.className = "scheduled-block-meta";
  meta.textContent = slot.start ? `Начало ${slot.start}` : "Фактическое начало не указано";
  heading.append(title, meta);

  if (orphan) {
    const warning = document.createElement("span");
    warning.className = "orphan-badge";
    warning.textContent = "Блок очищен";
    heading.appendChild(warning);
  }

  const collapseKey = `${day.date}|${interval}`;
  const isCollapsed = collapsedScheduledBlocks.has(collapseKey);
  article.classList.toggle("collapsed", isCollapsed);

  const collapseBtn = document.createElement("button");
  collapseBtn.type = "button";
  collapseBtn.className = "collapse-block-btn";
  collapseBtn.setAttribute("aria-label", isCollapsed ? "Развернуть временной блок" : "Свернуть временной блок");
  collapseBtn.setAttribute("aria-expanded", String(!isCollapsed));
  collapseBtn.textContent = isCollapsed ? "⌄" : "⌃";
  collapseBtn.addEventListener("click", () => {
    const collapsed = article.classList.toggle("collapsed");
    if (collapsed) collapsedScheduledBlocks.add(collapseKey);
    else collapsedScheduledBlocks.delete(collapseKey);
    collapseBtn.setAttribute("aria-expanded", String(!collapsed));
    collapseBtn.setAttribute("aria-label", collapsed ? "Развернуть временной блок" : "Свернуть временной блок");
    collapseBtn.textContent = collapsed ? "⌄" : "⌃";
  });

  header.append(heading, collapseBtn);

  const taskList = document.createElement("div");
  taskList.className = "scheduled-task-list";
  taskList.dataset.slot = interval;
  taskList.dataset.date = day.date;
  taskList.dataset.orphan = String(orphan);

  for (const task of tasks) {
    taskList.appendChild(createScheduledTaskRow(task));
  }

  if (!tasks.length) {
    const empty = document.createElement("p");
    empty.className = "block-empty";
    empty.textContent = "Задач пока нет";
    taskList.appendChild(empty);
  }

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "add-to-block-btn";
  addBtn.textContent = "+ Добавить задачу";
  addBtn.disabled = orphan;
  addBtn.addEventListener("click", () => openTaskDialog(null, { date: day.date, slot: interval }));

  article.append(header, taskList, addBtn);
  return article;
}

function createScheduledTaskRow(task) {
  const row = document.createElement("div");
  row.className = `scheduled-task-row${task.completed ? " completed" : ""}`;
  row.dataset.taskId = task.id;

  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "drag-handle scheduled-drag-handle";
  handle.setAttribute("aria-label", "Перетащить задачу");
  handle.title = "Перетащить";
  handle.innerHTML = "<span>⠿</span>";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "task-checkbox";
  checkbox.checked = task.completed;
  checkbox.setAttribute("aria-label", "Отметить задачу выполненной");
  checkbox.addEventListener("change", () => toggleTaskCompleted(task.id, checkbox.checked));

  const content = document.createElement("div");
  content.className = "scheduled-task-content";
  const title = document.createElement("button");
  title.type = "button";
  title.className = "task-title-button";
  title.textContent = task.title;
  title.addEventListener("click", () => openTaskDialog(task.id));
  content.appendChild(title);

  if (task.note) {
    const note = document.createElement("p");
    note.className = "task-note";
    note.textContent = task.note;
    content.appendChild(note);
  }

  const badges = document.createElement("div");
  badges.className = "mini-priority-row";

  const importanceBadge = document.createElement("span");
  importanceBadge.className = `mini-priority important${task.important ? " active" : ""}`;
  importanceBadge.textContent = task.important ? "Важно" : "Неважно";

  const urgencyBadge = document.createElement("span");
  urgencyBadge.className = `mini-priority urgent${task.urgent ? " active" : ""}`;
  urgencyBadge.textContent = task.urgent ? "Срочно" : "Несрочно";

  badges.append(importanceBadge, urgencyBadge);
  content.appendChild(badges);

  const menuBtn = document.createElement("button");
  menuBtn.type = "button";
  menuBtn.className = "more-btn small";
  menuBtn.textContent = "⋮";
  menuBtn.setAttribute("aria-label", "Действия с задачей");
  menuBtn.addEventListener("click", event => openTaskMenu(event.currentTarget, task));

  row.append(handle, checkbox, content, menuBtn);
  attachScheduledDragHandlers(handle, row);
  return row;
}

function attachScheduledDragHandlers(handle, row) {
  handle.addEventListener("pointerdown", event => {
    if (dragState) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();

    const sourceList = row.closest(".scheduled-task-list");
    if (!sourceList) return;

    const rect = row.getBoundingClientRect();
    const placeholder = document.createElement("div");
    placeholder.className = "scheduled-drag-placeholder";
    placeholder.style.height = `${rect.height}px`;
    row.after(placeholder);

    dragState = {
      kind: "scheduled",
      row,
      handle,
      placeholder,
      pointerId: event.pointerId,
      offsetY: event.clientY - rect.top,
      sourceList,
    };

    // Move the floating preview to <body>. The reminders card uses
    // backdrop-filter, which may become a containing block for position:fixed
    // in Firefox/WebKit and shift the preview away from the pointer.
    row.classList.add("dragging", "dragging-fixed");
    row.style.left = `${rect.left}px`;
    row.style.top = `${rect.top}px`;
    row.style.width = `${rect.width}px`;
    row.style.height = `${rect.height}px`;
    document.body.appendChild(row);
    document.body.classList.add("scheduled-drag-active");

    document.addEventListener("pointermove", onScheduledDragMove, { capture: true, passive: false });
    document.addEventListener("pointerup", finishScheduledDrag, { capture: true, passive: false });
    document.addEventListener("pointercancel", finishScheduledDrag, { capture: true, passive: false });
  });
}

function scheduledDropListAtPoint(clientX, clientY) {
  const lists = [...dom.scheduledBlocks.querySelectorAll('.scheduled-task-list[data-orphan="false"]')];
  return lists.find(list => {
    const block = list.closest(".scheduled-block");
    if (!block) return false;
    const rect = block.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }) ?? null;
}

function onScheduledDragMove(event) {
  if (!dragState || dragState.kind !== "scheduled" || dragState.pointerId !== event.pointerId) return;
  event.preventDefault();

  const { row, placeholder, offsetY } = dragState;
  row.style.top = `${event.clientY - offsetY}px`;

  const edge = 72;
  if (event.clientY < edge) window.scrollBy(0, -12);
  else if (event.clientY > window.innerHeight - edge) window.scrollBy(0, 12);

  const targetList = scheduledDropListAtPoint(event.clientX, event.clientY);
  if (!targetList) return;

  const draggedCompleted = row.classList.contains("completed");
  const allCandidates = [...targetList.querySelectorAll(".scheduled-task-row")].filter(item => item !== row);
  const candidates = allCandidates.filter(item => item.classList.contains("completed") === draggedCompleted);
  const before = candidates.find(item => {
    const rect = item.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2;
  });

  if (before) {
    targetList.insertBefore(placeholder, before);
  } else if (draggedCompleted) {
    targetList.appendChild(placeholder);
  } else {
    const firstCompleted = allCandidates.find(item => item.classList.contains("completed"));
    const emptyMessage = targetList.querySelector(".block-empty");
    if (firstCompleted) targetList.insertBefore(placeholder, firstCompleted);
    else if (emptyMessage) targetList.insertBefore(placeholder, emptyMessage);
    else targetList.appendChild(placeholder);
  }
}

async function finishScheduledDrag(event) {
  if (!dragState || dragState.kind !== "scheduled" || dragState.pointerId !== event.pointerId) return;
  event.preventDefault();

  const { row, placeholder, sourceList } = dragState;
  document.removeEventListener("pointermove", onScheduledDragMove, true);
  document.removeEventListener("pointerup", finishScheduledDrag, true);
  document.removeEventListener("pointercancel", finishScheduledDrag, true);

  row.classList.remove("dragging", "dragging-fixed");
  row.style.left = "";
  row.style.top = "";
  row.style.width = "";
  row.style.height = "";
  document.body.classList.remove("scheduled-drag-active");

  const destinationList = placeholder.closest(".scheduled-task-list") ?? sourceList;
  placeholder.replaceWith(row);
  dragState = null;

  await persistScheduledOrderFromDOM(destinationList);
}

async function persistScheduledOrderFromDOM(destinationList) {
  const visibleLists = [...dom.scheduledBlocks.querySelectorAll(".scheduled-task-list")];
  const byId = new Map(allTasks.map(task => [task.id, task]));
  const updates = [];

  for (const list of visibleLists) {
    const date = list.dataset.date;
    const slot = list.dataset.slot;
    if (!date || !slot) continue;

    const rows = [...list.querySelectorAll(".scheduled-task-row")];
    rows.forEach((row, index) => {
      const task = byId.get(row.dataset.taskId);
      if (!task) return;
      const changedSlot = task.scheduled?.date !== date || task.scheduled?.slot !== slot;
      const changedOrder = task.order !== index;
      if (!changedSlot && !changedOrder) return;

      task.scheduled = { date, slot };
      task.order = index;
      task.updatedAt = Date.now();
      updates.push(putTask(task));
    });
  }

  await Promise.all(updates);
  await refreshTasksOnly();
  renderScheduled();
  if (!dom.calendarView.hidden) await renderPlanner();

  if (destinationList) {
    showToast("Порядок задач сохранён");
  }
}

function renderReminders() {
  renderQueue();
  renderScheduled();
}

async function refreshTasksOnly() {
  allTasks = (await getAllTasks()).map(normalizeTask);
}

function nextQueueOrder() {
  const tasks = queueTasks();
  return tasks.length ? Math.max(...tasks.map(task => task.order)) + 1 : 0;
}

async function toggleTaskCompleted(id, completed) {
  const task = allTasks.find(item => item.id === id);
  if (!task) return;

  const wasCompleted = task.completed;
  task.completed = completed;

  // A newly completed task goes to the absolute bottom of its current list.
  // If it is later marked unfinished again, the completion-group sort places it
  // after the other unfinished tasks while preserving its stored manual order.
  if (!wasCompleted && completed) {
    const siblings = allTasks.filter(item => {
      if (item.id === task.id) return false;
      if (!task.scheduled) return !item.scheduled;
      return item.scheduled?.date === task.scheduled.date
        && item.scheduled?.slot === task.scheduled.slot;
    });
    const maxOrder = siblings.length ? Math.max(...siblings.map(item => item.order)) : -1;
    task.order = maxOrder + 1;
  }

  task.updatedAt = Date.now();
  await putTask(task);
  await refreshTasksOnly();
  renderReminders();
  if (!dom.calendarView.hidden) await renderPlanner();
}

function setPriorityToggle(button, active) {
  button.classList.toggle("active", active);
  button.setAttribute("aria-pressed", String(active));
  const prop = button.dataset.priority;
  if (prop) button.textContent = priorityLabel(prop, active);
}

function openTaskDialog(taskId = null, presetSchedule = null) {
  editingTaskId = taskId;
  taskPresetSchedule = presetSchedule;
  const task = taskId ? allTasks.find(item => item.id === taskId) : null;

  dom.taskDialogTitle.textContent = task ? "Редактировать задачу" : "Новая задача";
  dom.taskTitleInput.value = task?.title ?? "";
  dom.taskNoteInput.value = task?.note ?? "";
  setPriorityToggle(dom.taskImportantToggle, task?.important ?? false);
  setPriorityToggle(dom.taskUrgentToggle, task?.urgent ?? false);
  dom.taskDialog.showModal();
  setTimeout(() => dom.taskTitleInput.focus(), 0);
}

async function saveTaskFromDialog() {
  const title = dom.taskTitleInput.value.trim();
  if (!title) return;

  const existing = editingTaskId ? allTasks.find(item => item.id === editingTaskId) : null;
  const now = Date.now();
  const task = normalizeTask(existing ?? {
    id: uuid(),
    title: "",
    note: "",
    important: false,
    urgent: false,
    completed: false,
    order: nextQueueOrder(),
    scheduled: taskPresetSchedule,
    createdAt: now,
    updatedAt: now,
  });

  task.title = title;
  task.note = dom.taskNoteInput.value.trim();
  task.important = dom.taskImportantToggle.getAttribute("aria-pressed") === "true";
  task.urgent = dom.taskUrgentToggle.getAttribute("aria-pressed") === "true";
  if (!existing && taskPresetSchedule) task.scheduled = { ...taskPresetSchedule };
  task.updatedAt = now;

  await putTask(task);
  await refreshTasksOnly();
  dom.taskDialog.close();
  renderReminders();
  if (!dom.calendarView.hidden) await renderPlanner();
  showToast(existing ? "Задача обновлена" : "Задача создана");
}

async function openScheduleDialog(taskId) {
  schedulingTaskId = taskId;
  const task = allTasks.find(item => item.id === taskId);
  if (!task) return;

  dom.scheduleTaskName.textContent = task.title;
  const today = startOfDay(new Date());
  const preferred = task.scheduled?.date
    ? parseDateKey(task.scheduled.date)
    : (selectedDate >= today ? selectedDate : today);
  dom.scheduleDateInput.value = dateKey(preferred);
  await renderScheduleSlotChoices(task.scheduled?.slot ?? null);
  dom.scheduleDialog.showModal();
}

async function renderScheduleSlotChoices(preselectSlot = null) {
  const key = dom.scheduleDateInput.value;
  if (!key) return;

  const date = parseDateKey(key);
  const record = normalizeRecord(await getDay(key), date);
  dom.scheduleSlotChoices.innerHTML = "";

  const available = SLOTS.filter(interval => ACTIVITY_TYPES.has(record.slots[interval]?.category));
  dom.scheduleNoSlots.hidden = available.length > 0;
  dom.confirmScheduleBtn.disabled = available.length === 0;

  for (const interval of available) {
    const slot = record.slots[interval];
    const label = document.createElement("label");
    label.className = "schedule-slot-option";
    label.dataset.category = slot.category;

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "scheduleSlot";
    radio.value = interval;
    radio.checked = interval === preselectSlot || (!preselectSlot && available[0] === interval);

    const text = document.createElement("span");
    text.className = "schedule-slot-text";
    const strong = document.createElement("strong");
    strong.textContent = `${interval} · ${CATEGORY_LABELS[slot.category]}`;
    const meta = document.createElement("small");
    meta.textContent = slot.start ? `Начало ${slot.start}` : "Начало не указано";
    text.append(strong, meta);

    label.append(radio, text);
    dom.scheduleSlotChoices.appendChild(label);
  }
}

async function scheduleCurrentTask() {
  const task = allTasks.find(item => item.id === schedulingTaskId);
  const slotInput = dom.scheduleSlotChoices.querySelector('input[name="scheduleSlot"]:checked');
  if (!task || !dom.scheduleDateInput.value || !slotInput) return;

  task.scheduled = {
    date: dom.scheduleDateInput.value,
    slot: slotInput.value,
  };
  task.updatedAt = Date.now();
  await putTask(task);
  await refreshTasksOnly();
  dom.scheduleDialog.close();
  scheduledDate = parseDateKey(task.scheduled.date);
  renderReminders();
  showToast("Задача запланирована");
}

async function unscheduleTask(task) {
  task.scheduled = null;
  task.order = nextQueueOrder();
  task.updatedAt = Date.now();
  await putTask(task);
  await refreshTasksOnly();
  renderReminders();
  if (!dom.calendarView.hidden) await renderPlanner();
  showToast("Задача возвращена в Очередь");
}

async function removeTask(task) {
  const confirmed = window.confirm(`Удалить задачу «${task.title}»?`);
  if (!confirmed) return;
  await deleteTaskRecord(task.id);
  await refreshTasksOnly();
  renderReminders();
  if (!dom.calendarView.hidden) await renderPlanner();
  showToast("Задача удалена");
}

function openTaskMenu(anchor, task) {
  document.querySelectorAll(".task-menu").forEach(menu => menu.remove());
  const menu = document.createElement("div");
  menu.className = "task-menu";

  menu.appendChild(menuAction("Редактировать", () => openTaskDialog(task.id)));

  if (task.scheduled) {
    menu.appendChild(menuAction("Перенести", () => openScheduleDialog(task.id)));
    menu.appendChild(menuAction("Вернуть в очередь", () => unscheduleTask(task)));
  } else {
    menu.appendChild(menuAction("Запланировать", () => openScheduleDialog(task.id)));
  }

  menu.appendChild(menuAction("Удалить", () => removeTask(task), true));
  document.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const margin = 10;
  const gap = 6;
  const left = Math.min(
    window.innerWidth - menuRect.width - margin,
    Math.max(margin, rect.right - menuRect.width),
  );
  const below = rect.bottom + gap;
  const above = rect.top - menuRect.height - gap;
  const top = below + menuRect.height <= window.innerHeight - margin
    ? below
    : Math.max(margin, above);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const close = event => {
    if (!menu.contains(event.target) && event.target !== anchor) {
      menu.remove();
      document.removeEventListener("pointerdown", close, true);
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

function menuAction(label, handler, danger = false) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  if (danger) btn.classList.add("danger");
  btn.addEventListener("click", () => {
    btn.closest(".task-menu")?.remove();
    handler();
  });
  return btn;
}

function currentScrollKey() {
  return activeMainView === "calendar" ? "calendar" : activeReminderTab;
}

function saveCurrentScrollPosition() {
  scrollPositions[currentScrollKey()] = window.scrollY;
}

function restoreScrollPosition(key, targetElement = null) {
  const top = scrollPositions[key] ?? 0;
  // Restore within the same event turn. Waiting for animation frames makes
  // the browser paint scrollY=0 first, producing a visible jump. Reading
  // offsetHeight forces layout after hidden panels are revealed/rendered.
  if (targetElement) void targetElement.offsetHeight;
  window.scrollTo({ top, left: 0, behavior: "auto" });
}

function setMainView(view) {
  saveCurrentScrollPosition();

  const calendar = view === "calendar";
  dom.calendarView.hidden = !calendar;
  dom.remindersView.hidden = calendar;
  dom.calendarView.classList.toggle("active", calendar);
  dom.remindersView.classList.toggle("active", !calendar);
  dom.navCalendarBtn.classList.toggle("active", calendar);
  dom.navRemindersBtn.classList.toggle("active", !calendar);
  dom.navCalendarBtn.toggleAttribute("aria-current", calendar);
  dom.navRemindersBtn.toggleAttribute("aria-current", !calendar);

  activeMainView = calendar ? "calendar" : "reminders";

  if (!calendar) {
    // Every entry into Reminders starts with the Scheduled tab.
    setReminderTab("scheduled", { saveScroll: false, restoreScroll: false });
  }

  restoreScrollPosition(currentScrollKey(), calendar ? dom.calendarView : dom.remindersView);
}

function setReminderTab(tab, options = {}) {
  const { saveScroll = true, restoreScroll = true } = options;

  if (saveScroll && activeMainView === "reminders") {
    scrollPositions[activeReminderTab] = window.scrollY;
  }

  const queue = tab === "queue";
  activeReminderTab = queue ? "queue" : "scheduled";
  dom.queuePanel.hidden = !queue;
  dom.scheduledPanel.hidden = queue;
  dom.queuePanel.classList.toggle("active", queue);
  dom.scheduledPanel.classList.toggle("active", !queue);
  dom.queueTabBtn.classList.toggle("active", queue);
  dom.scheduledTabBtn.classList.toggle("active", !queue);
  dom.queueTabBtn.setAttribute("aria-selected", String(queue));
  dom.scheduledTabBtn.setAttribute("aria-selected", String(!queue));
  if (queue) renderQueue(); else renderScheduled();

  if (restoreScroll && activeMainView === "reminders") {
    restoreScrollPosition(activeReminderTab, queue ? dom.queuePanel : dom.scheduledPanel);
  }
}

function moveScheduledDate(days) {
  scheduledDate = new Date(scheduledDate.getFullYear(), scheduledDate.getMonth(), scheduledDate.getDate() + days);
  renderScheduled();
}

function showToast(message) {
  clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  requestAnimationFrame(() => dom.toast.classList.add("visible"));
  toastTimer = setTimeout(() => {
    dom.toast.classList.remove("visible");
    setTimeout(() => { dom.toast.hidden = true; }, 180);
  }, 1800);
}

function bindEvents() {
  document.querySelector("#prevMonthBtn").addEventListener("click", () => {
    currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
    renderCalendar();
  });

  document.querySelector("#nextMonthBtn").addEventListener("click", () => {
    currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
    renderCalendar();
  });

  document.querySelector("#todayBtn").addEventListener("click", async () => {
    selectedDate = startOfDay(new Date());
    currentMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
    renderCalendar();
    await renderPlanner();
  });

  dom.navCalendarBtn.addEventListener("click", () => setMainView("calendar"));
  dom.navRemindersBtn.addEventListener("click", () => setMainView("reminders"));
  dom.queueTabBtn.addEventListener("click", () => setReminderTab("queue"));
  dom.scheduledTabBtn.addEventListener("click", () => setReminderTab("scheduled"));
  dom.addQueueTaskBtn.addEventListener("click", () => openTaskDialog());

  document.querySelector("#scheduledPrevDayBtn").addEventListener("click", () => moveScheduledDate(-1));
  document.querySelector("#scheduledNextDayBtn").addEventListener("click", () => moveScheduledDate(1));
  document.querySelector("#scheduledTodayBtn").addEventListener("click", () => {
    scheduledDate = startOfDay(new Date());
    renderScheduled();
  });

  dom.taskImportantToggle.addEventListener("click", () => {
    setPriorityToggle(dom.taskImportantToggle, dom.taskImportantToggle.getAttribute("aria-pressed") !== "true");
  });
  dom.taskUrgentToggle.addEventListener("click", () => {
    setPriorityToggle(dom.taskUrgentToggle, dom.taskUrgentToggle.getAttribute("aria-pressed") !== "true");
  });

  dom.taskForm.addEventListener("submit", event => {
    event.preventDefault();
    saveTaskFromDialog();
  });

  dom.scheduleDateInput.addEventListener("change", () => renderScheduleSlotChoices());
  dom.scheduleForm.addEventListener("submit", event => {
    event.preventDefault();
    scheduleCurrentTask();
  });

  dom.openScheduleDateInCalendarBtn.addEventListener("click", async () => {
    if (!dom.scheduleDateInput.value) return;
    selectedDate = parseDateKey(dom.scheduleDateInput.value);
    currentMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
    dom.scheduleDialog.close();
    setMainView("calendar");
    renderCalendar();
    await renderPlanner();
  });

  document.querySelectorAll("[data-close-dialog]").forEach(button => {
    button.addEventListener("click", () => {
      const dialog = document.getElementById(button.dataset.closeDialog);
      dialog?.close();
    });
  });

  for (const dialog of [dom.taskDialog, dom.scheduleDialog]) {
    dialog.addEventListener("click", event => {
      if (event.target === dialog) dialog.close();
    });
  }
}

async function init() {
  bindEvents();
  await refreshData();
  renderCalendar();
  await renderPlanner();
  renderReminders();
  setReminderTab("scheduled", { saveScroll: false, restoreScroll: false });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js?v=39").catch(console.error);
    });
  }
}

init().catch(error => {
  console.error(error);
  dom.saveStatus.textContent = "Ошибка локального хранилища";
  showToast("Не удалось открыть локальную базу данных");
});
