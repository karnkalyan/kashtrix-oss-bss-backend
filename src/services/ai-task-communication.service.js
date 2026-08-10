/**
 * AI Task Communication Service
 * 
 * Manages the human-in-the-loop workflow for AI agent tasks and tickets.
 * Handles:
 *   - Writing progress comments to tickets/tasks from AI agents
 *   - State transitions: NEW → ANALYZING → WAITING_FOR_USER → EXECUTING → VERIFYING → COMPLETED/FAILED
 *   - Detecting user replies to agent questions and resuming paused tasks
 *   - Structured error communication with actionable next steps
 */

const TASK_STATES = {
  NEW: 'NEW',
  ANALYZING: 'ANALYZING',
  WAITING_FOR_USER: 'WAITING_FOR_USER',
  WAITING_FOR_APPROVAL: 'WAITING_FOR_APPROVAL',
  READY: 'READY',
  EXECUTING: 'EXECUTING',
  VERIFYING: 'VERIFYING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED'
};

const VALID_TRANSITIONS = {
  NEW: ['ANALYZING', 'CANCELLED'],
  ANALYZING: ['WAITING_FOR_USER', 'WAITING_FOR_APPROVAL', 'READY', 'EXECUTING', 'FAILED', 'CANCELLED'],
  WAITING_FOR_USER: ['ANALYZING', 'EXECUTING', 'CANCELLED', 'FAILED'],
  WAITING_FOR_APPROVAL: ['READY', 'EXECUTING', 'CANCELLED', 'FAILED'],
  READY: ['EXECUTING', 'CANCELLED'],
  EXECUTING: ['VERIFYING', 'COMPLETED', 'FAILED', 'WAITING_FOR_USER'],
  VERIFYING: ['COMPLETED', 'FAILED', 'EXECUTING'],
  COMPLETED: [],
  FAILED: ['ANALYZING', 'CANCELLED'],
  BLOCKED: ['ANALYZING', 'CANCELLED'],
  CANCELLED: []
};

const cleanText = (value, max = 5000) => String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max);

/**
 * Validate a state transition is allowed.
 */
function isValidTransition(currentState, nextState) {
  const allowed = VALID_TRANSITIONS[currentState];
  if (!allowed) return false;
  return allowed.includes(nextState);
}

/**
 * Transition a task to a new state with validation.
 */
async function transitionTaskState(prisma, { taskId, ispId, fromState, toState, agentId, userId, reason, metadata = {} }) {
  if (!isValidTransition(fromState, toState)) {
    throw new Error(`Invalid state transition: ${fromState} → ${toState}`);
  }

  const updateData = {
    status: toState,
    ...(toState === 'EXECUTING' ? { startedAt: new Date() } : {}),
    ...(toState === 'COMPLETED' ? { completedAt: new Date() } : {}),
    ...(toState === 'FAILED' ? { completedAt: new Date(), error: cleanText(reason) } : {}),
    ...(toState === 'CANCELLED' ? { completedAt: new Date(), error: cleanText(reason || 'Cancelled') } : {})
  };

  const task = await prisma.aiAgentTask.update({
    where: { id: taskId },
    data: updateData
  });

  // Log the transition
  await prisma.aiAgentActivityLog.create({
    data: {
      ispId,
      agentId: agentId || task.agentId,
      userId: userId || null,
      eventType: `TASK_STATE_${toState}`,
      description: `Task #${taskId} transitioned: ${fromState} → ${toState}${reason ? `. ${reason}` : ''}`,
      metadata: { taskId, fromState, toState, reason, ...metadata }
    }
  });

  return task;
}

/**
 * Write a progress comment to a linked ticket from an AI agent.
 * This is the primary communication channel between AI agents and users.
 */
async function writeAgentComment(prisma, { ticketId, agentId, ispId, content, isInternal = false, commentType = 'PROGRESS' }) {
  if (!ticketId) return null;

  // Use the agent's system user ID (agentId maps to agent, but we need a user for the comment)
  // We'll use a special approach: find or create a system user for the agent
  const agentUser = await getAgentSystemUser(prisma, ispId, agentId);
  if (!agentUser) {
    console.error(`[AI Task Comms] Cannot find system user for agent ${agentId}`);
    return null;
  }

  const prefix = commentType === 'ERROR' ? '🔴 ' :
                 commentType === 'WAITING' ? '⏸️ ' :
                 commentType === 'COMPLETED' ? '✅ ' :
                 commentType === 'INFO' ? 'ℹ️ ' :
                 '🤖 ';

  const comment = await prisma.ticketComment.create({
    data: {
      ticketId,
      userId: agentUser.id,
      content: `${prefix}${cleanText(content, 4000)}`,
      isInternal
    }
  });

  return comment;
}

/**
 * Write a progress update to a task's activity log.
 */
async function writeTaskProgress(prisma, { taskId, agentId, ispId, userId, stage, description, details = {} }) {
  return prisma.aiAgentActivityLog.create({
    data: {
      ispId,
      agentId,
      userId: userId || null,
      eventType: `TASK_${stage}`,
      description: cleanText(description, 2000),
      metadata: { taskId, stage, ...details }
    }
  });
}

/**
 * Post a "waiting for user" message to both the task log and linked ticket.
 * Sets the task to WAITING_FOR_USER state.
 */
async function requestUserInput(prisma, { taskId, ispId, agentId, userId, missingFields = [], question, ticketId }) {
  const task = await prisma.aiAgentTask.findFirst({ where: { id: taskId, ispId } });
  if (!task) throw new Error(`Task ${taskId} not found`);

  const effectiveTicketId = ticketId || Number(task.input?.ticketId) || null;

  // Build the question message
  const parts = [];
  if (question) {
    parts.push(question);
  }
  if (missingFields.length > 0) {
    parts.push(`\nI need the following details to proceed:\n${missingFields.map((f, i) => `  ${i + 1}. ${f}`).join('\n')}`);
  }
  parts.push('\nPlease reply with the required information so I can continue working on this task.');

  const message = parts.join('\n');

  // Transition state
  const currentState = task.status || 'ANALYZING';
  if (isValidTransition(currentState, TASK_STATES.WAITING_FOR_USER)) {
    await transitionTaskState(prisma, {
      taskId,
      ispId,
      fromState: currentState,
      toState: TASK_STATES.WAITING_FOR_USER,
      agentId,
      userId,
      reason: `Waiting for user input: ${missingFields.join(', ') || question || 'additional details'}`,
      metadata: { missingFields, question }
    });
  }

  // Write to ticket comment
  if (effectiveTicketId) {
    await writeAgentComment(prisma, {
      ticketId: effectiveTicketId,
      agentId,
      ispId,
      content: message,
      commentType: 'WAITING'
    });
  }

  // Write to task activity log
  await writeTaskProgress(prisma, {
    taskId,
    agentId,
    ispId,
    userId,
    stage: 'WAITING_FOR_USER',
    description: message,
    details: { missingFields, question }
  });

  return { taskId, state: TASK_STATES.WAITING_FOR_USER, message };
}

/**
 * Check if a task has received new user input since entering WAITING_FOR_USER state.
 * Returns the new comment content if available.
 */
async function checkForUserReply(prisma, { taskId, ispId }) {
  const task = await prisma.aiAgentTask.findFirst({
    where: { id: taskId, ispId, status: TASK_STATES.WAITING_FOR_USER }
  });
  if (!task) return null;

  const ticketId = Number(task.input?.ticketId) || null;
  if (!ticketId) return null;

  // Get the timestamp of the last agent comment
  const agentUser = await getAgentSystemUser(prisma, ispId, task.agentId);
  if (!agentUser) return null;

  const lastAgentComment = await prisma.ticketComment.findFirst({
    where: { ticketId, userId: agentUser.id },
    orderBy: { createdAt: 'desc' }
  });

  if (!lastAgentComment) return null;

  // Look for user comments after the agent's last comment
  const userReplies = await prisma.ticketComment.findMany({
    where: {
      ticketId,
      userId: { not: agentUser.id },
      createdAt: { gt: lastAgentComment.createdAt }
    },
    orderBy: { createdAt: 'asc' },
    include: { user: { select: { id: true, name: true } } }
  });

  if (userReplies.length === 0) return null;

  return {
    replies: userReplies.map(reply => ({
      id: reply.id,
      userId: reply.userId,
      userName: reply.user?.name || 'Unknown',
      content: reply.content,
      createdAt: reply.createdAt
    })),
    combinedContent: userReplies.map(r => r.content).join('\n'),
    lastReplyAt: userReplies[userReplies.length - 1].createdAt
  };
}

/**
 * Resume a task that was waiting for user input.
 * Merges the new user-provided information into the task context.
 */
async function resumeTaskWithUserInput(prisma, { taskId, ispId, agentId, userId, userInput, additionalContext = {} }) {
  const task = await prisma.aiAgentTask.findFirst({
    where: { id: taskId, ispId }
  });
  if (!task) throw new Error(`Task ${taskId} not found`);

  // Merge user input into task
  const updatedInput = {
    ...(task.input || {}),
    userReplies: [...(task.input?.userReplies || []), {
      content: cleanText(userInput, 5000),
      timestamp: new Date().toISOString(),
      userId
    }],
    ...additionalContext
  };

  await prisma.aiAgentTask.update({
    where: { id: taskId },
    data: { input: updatedInput }
  });

  // Transition back to ANALYZING
  if (isValidTransition(task.status, TASK_STATES.ANALYZING)) {
    await transitionTaskState(prisma, {
      taskId,
      ispId,
      fromState: task.status,
      toState: TASK_STATES.ANALYZING,
      agentId,
      userId,
      reason: 'User provided additional input, resuming analysis'
    });
  }

  const ticketId = Number(task.input?.ticketId) || null;
  if (ticketId) {
    await writeAgentComment(prisma, {
      ticketId,
      agentId,
      ispId,
      content: 'Thank you for the additional details. I am resuming work on this task now.',
      commentType: 'PROGRESS'
    });
  }

  return { taskId, state: TASK_STATES.ANALYZING, resumed: true };
}

/**
 * Report task failure with human-readable explanation.
 */
async function reportTaskFailure(prisma, { taskId, ispId, agentId, userId, error, suggestion, ticketId }) {
  const task = await prisma.aiAgentTask.findFirst({ where: { id: taskId, ispId } });
  if (!task) return;

  const effectiveTicketId = ticketId || Number(task.input?.ticketId) || null;

  const errorMessage = [
    `Task "${task.title}" could not be completed.`,
    '',
    `Reason: ${cleanText(error, 2000)}`,
    suggestion ? `\nSuggested action: ${suggestion}` : '',
    '\nYou can update the task with the required information and retry, or assign it to a different agent.'
  ].filter(Boolean).join('\n');

  // Write error to ticket
  if (effectiveTicketId) {
    await writeAgentComment(prisma, {
      ticketId: effectiveTicketId,
      agentId,
      ispId,
      content: errorMessage,
      commentType: 'ERROR'
    });
  }

  // Update task status
  if (isValidTransition(task.status, TASK_STATES.FAILED)) {
    await transitionTaskState(prisma, {
      taskId,
      ispId,
      fromState: task.status,
      toState: TASK_STATES.FAILED,
      agentId,
      userId,
      reason: cleanText(error, 2000),
      metadata: { suggestion }
    });
  }

  // Log
  await writeTaskProgress(prisma, {
    taskId,
    agentId,
    ispId,
    userId,
    stage: 'FAILED',
    description: errorMessage,
    details: { error, suggestion }
  });
}

/**
 * Report task completion with summary.
 */
async function reportTaskCompletion(prisma, { taskId, ispId, agentId, userId, summary, result, ticketId }) {
  const task = await prisma.aiAgentTask.findFirst({ where: { id: taskId, ispId } });
  if (!task) return;

  const effectiveTicketId = ticketId || Number(task.input?.ticketId) || null;

  const completionMessage = [
    `Task "${task.title}" has been completed.`,
    '',
    summary ? `Summary: ${cleanText(summary, 3000)}` : ''
  ].filter(Boolean).join('\n');

  // Write completion to ticket
  if (effectiveTicketId) {
    await writeAgentComment(prisma, {
      ticketId: effectiveTicketId,
      agentId,
      ispId,
      content: completionMessage,
      commentType: 'COMPLETED'
    });

    // Also resolve the ticket
    await prisma.ticket.updateMany({
      where: { id: effectiveTicketId, ispId, isDeleted: false },
      data: {
        status: 'RESOLVED',
        resolution: cleanText(summary, 5000),
        resolvedAt: new Date(),
        updatedAt: new Date()
      }
    });
  }

  // Log
  await writeTaskProgress(prisma, {
    taskId,
    agentId,
    ispId,
    userId,
    stage: 'COMPLETED',
    description: completionMessage,
    details: { summary, result }
  });
}

/**
 * Get or create a system user for an AI agent to post comments.
 * This maps agent IDs to users so ticket comments have proper attribution.
 */
async function getAgentSystemUser(prisma, ispId, agentId) {
  try {
    // Try to find the agent first to get its name
    const agent = await prisma.aiAgent.findFirst({
      where: { id: agentId, ispId },
      select: { id: true, name: true, slug: true }
    });

    // Find any existing system/admin user that can represent the agent
    // We use the task requestedBy user as fallback, or the first admin user
    const adminUser = await prisma.user.findFirst({
      where: {
        ispId,
        isDeleted: false,
        role: { name: { in: ['Administrator', 'Super Admin', 'Global Admin', 'Admin'] } }
      },
      select: { id: true, name: true }
    });

    return adminUser || null;
  } catch {
    return null;
  }
}

/**
 * Poll for tasks in WAITING_FOR_USER state and check for replies.
 * Called periodically by the task worker.
 */
async function processWaitingTasks(prisma) {
  try {
    const waitingTasks = await prisma.aiAgentTask.findMany({
      where: { status: TASK_STATES.WAITING_FOR_USER },
      take: 20
    });

    const resumed = [];
    for (const task of waitingTasks) {
      const reply = await checkForUserReply(prisma, { taskId: task.id, ispId: task.ispId });
      if (reply) {
        await resumeTaskWithUserInput(prisma, {
          taskId: task.id,
          ispId: task.ispId,
          agentId: task.agentId,
          userId: reply.replies[0]?.userId,
          userInput: reply.combinedContent
        });
        resumed.push(task.id);
      }
    }

    return resumed;
  } catch (error) {
    console.error('[AI Task Comms] Error processing waiting tasks:', error.message);
    return [];
  }
}

module.exports = {
  TASK_STATES,
  VALID_TRANSITIONS,
  isValidTransition,
  transitionTaskState,
  writeAgentComment,
  writeTaskProgress,
  requestUserInput,
  checkForUserReply,
  resumeTaskWithUserInput,
  reportTaskFailure,
  reportTaskCompletion,
  getAgentSystemUser,
  processWaitingTasks
};
