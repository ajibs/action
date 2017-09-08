import {GraphQLID, GraphQLList, GraphQLNonNull} from 'graphql';
import getRethink from 'server/database/rethinkDriver';
import asyncInviteTeam from 'server/graphql/models/Invitation/inviteTeamMembers/asyncInviteTeam';
import createPendingApprovals from 'server/graphql/models/Invitation/inviteTeamMembers/createPendingApprovals';
import getInviterInfoAndTeamName from 'server/graphql/models/Invitation/inviteTeamMembers/getInviterInfoAndTeamName';
import removeOrgApprovalAndNotification from 'server/graphql/models/Organization/rejectOrgApproval/removeOrgApprovalAndNotification';
import InviteTeamMembersPayload from 'server/graphql/types/InviteTeamMembersPayload';
import {getUserId, getUserOrgDoc, isBillingLeader, requireOrgLeaderOrTeamMember} from 'server/utils/authorization';
import getPubSub from 'server/utils/getPubSub';
import tmsSignToken from 'server/utils/tmsSignToken';
import shortid from 'shortid';
import {PRESENCE, REJOIN_TEAM} from 'universal/subscriptions/constants';
import {
  ADD_TO_TEAM,
  ALREADY_ON_TEAM,
  NOTIFICATION_ADDED,
  PENDING_APPROVAL,
  REACTIVATED,
  SUCCESS
} from 'universal/utils/constants';
import {Invitee} from '../models/Invitation/invitationSchema';
import {ASK_APPROVAL, SEND_EMAIL, SEND_NOTIFICATION} from 'server/utils/serverConstants';
import sendInvitationViaNotification from 'server/safeMutations/sendInvitationViaNotification';


const reactivateAndSendWelcomeBack = async (invitees, inviter, exchange) => {
  if (invitees.length === 0) return;
  const {orgId, teamId, teamName, inviterName} = inviter;
  const r = getRethink();
  const now = new Date();
  const userIds = invitees.map(({userId}) => userId);
  const teamMemberIds = userIds.map((userId) => `${userId}::${teamId}`);
  const {reactivatedUsers} = await r({
    reactivatedTeamMembers: r.table('TeamMember')
      .getAll(r.args(teamMemberIds), {index: 'id'})
      .update({isNotRemoved: true}),
    reactivatedUsers: r.table('User')
      .getAll(r.args(userIds))
      .update((user) => {
        return user.merge({
          tms: user('tms').append(teamId)
        });
      }, {returnChanges: true})('changes')('new_val')
      .default(null)
  });
  const notifications = reactivatedUsers.map((user) => ({
    id: shortid.generate(),
    type: ADD_TO_TEAM,
    startAt: now,
    orgId,
    userIds: [user.id],
    inviterName,
    teamName
  }));
  await r.table('Notification').insert(notifications);
  reactivatedUsers.forEach((user) => {
    const {preferredName, id: reactivatedUserId, tms} = user;
    const notificationAdded = {
      notification: {
        _authToken: tmsSignToken({sub: reactivatedUserId}, tms),
        inviterName,
        teamId,
        teamName,
        type: ADD_TO_TEAM
      }
    };
    getPubSub().publish(`${NOTIFICATION_ADDED}.${reactivatedUserId}`, {notificationAdded});
    const channel = `${PRESENCE}/${teamId}`;
    // TODO refactor out exchange
    exchange.publish(channel, {
      type: REJOIN_TEAM,
      name: preferredName,
      sender: inviter.userId
    });
  });
};

const getAction = (invitee, inviterIsBillingLeader) => {
  const {
    isActiveTeamMember,
    isPendingApproval,
    isPendingInvitation,
    isActiveUser,
    isNewTeamMember,
    isOrgMember
  } = invitee;
  if (isActiveTeamMember) return ALREADY_ON_TEAM;
  if (isPendingApproval && !inviterIsBillingLeader) return PENDING_APPROVAL;
  if (isPendingInvitation) return SUCCESS;
  if (isOrgMember) {
    return isNewTeamMember ? SEND_NOTIFICATION : REACTIVATED;
  }
  if (inviterIsBillingLeader) {
    return isActiveUser ? SEND_NOTIFICATION : SEND_EMAIL;
  }
  return ASK_APPROVAL;
};

export default {
  type: new GraphQLNonNull(InviteTeamMembersPayload),
  description: `If in the org,
     Send invitation emails to a list of email addresses, add them to the invitation table.
     Else, send a request to the org leader to get them approval and put them in the OrgApproval table.`,
  args: {
    teamId: {
      type: new GraphQLNonNull(GraphQLID),
      description: 'The id of the inviting team'
    },
    invitees: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Invitee)))
    }
    // notificationId: {
    //   type: GraphQLID
    // }
  },
  async resolve(source, {invitees, teamId}, {authToken, exchange}) {
    const r = getRethink();
    const now = Date.now();

    // AUTH
    await requireOrgLeaderOrTeamMember(authToken, teamId);
    const userId = getUserId(authToken);
    const {name: teamName, orgId} = await r.table('Team').get(teamId).pluck('name', 'orgId');
    const userOrgDoc = await getUserOrgDoc(userId, orgId);
    const inviterIsBillingLeader = isBillingLeader(userOrgDoc);

    const emailArr = invitees.map((invitee) => invitee.email);
    const {pendingInvitations, pendingApprovals, teamMembers, users} = await r.expr({
      pendingInvitations: r.table('Invitation')
        .getAll(r.args(emailArr), {index: 'email'})
        .filter((invitation) => invitation('tokenExpiration').ge(r.epochTime(now)))('email')
        .coerceTo('array'),
      pendingApprovals: r.table('OrgApproval')
        .getAll(r.args(emailArr), {index: 'email'})
        .filter({teamId})
        .coerceTo('array'),
      teamMembers: r.table('TeamMember')
        .getAll(teamId, {index: 'teamId'})
        .coerceTo('array'),
      users: r.table('User')
        .getAll(r.args(emailArr), {index: 'email'})
        .coerceTo('array')
    });

    // RESOLUTION
    const activeTeamMembers = teamMembers.filter((m) => m.isNotRemoved === true).map((m) => m.email);
    const inactiveTeamMembers = teamMembers.filter((m) => !m.isNotRemoved).map((m) => m.email);
    const inviterAndTeamName = await getInviterInfoAndTeamName(teamId, userId);
    const inviterDetails = {
      ...inviterAndTeamName,
      orgId,
      teamId
    };

    const detailedInvitations = emailArr.map((email) => {
      const userDoc = users.find((user) => user.email === email);
      const details = {
        email,
        isActiveTeamMember: activeTeamMembers.includes(email),
        isPendingApproval: pendingApprovals.includes(email),
        isPendingInvitation: pendingInvitations.includes(email),
        isUser: Boolean(userDoc),
        isActiveUser: userDoc && !userDoc.inactive,
        isOrgMember: userDoc && userDoc.userOrgs.includes((userDocOrg) => userDocOrg.id === orgId),
        isNewTeamMember: !inactiveTeamMembers.includes((tm) => tm.email === email),
        userId: userDoc && userDoc.id
      };
      return {
        ...details,
        action: getAction(details, inviterIsBillingLeader)
      };
    });

    const inviteesToReactivate = detailedInvitations.filter(({action}) => action === REACTIVATED);
    const inviteesToNotify = detailedInvitations.filter(({action}) => action === SEND_NOTIFICATION);
    const inviteesToEmail = detailedInvitations.filter(({action}) => action === SEND_EMAIL);
    const inviteesToApprove = detailedInvitations.filter(({action}) => action === ASK_APPROVAL);
    const approvalEmails = inviteesToApprove.map(({email}) => email);
    const approvalsToClear = inviteesToNotify.concat(inviteesToEmail).map(({email}) => email);

    const invitesByUserId = inviteesToEmail.reduce((invitations, invitee) => {
      const {email} = invitee;
      invitations[userId] = invitations[userId] || [];
      invitations[userId].push(email);
      return invitations;
    }, {});
    const sendEmails = Object.keys(invitesByUserId)
      .map((inviterId) => asyncInviteTeam(inviterId, teamId, invitesByUserId[inviterId]));

    await Promise.all([
      removeOrgApprovalAndNotification(orgId, approvalsToClear),
      reactivateAndSendWelcomeBack(inviteesToReactivate, inviterDetails, exchange),
      sendInvitationViaNotification(inviteesToNotify, inviterDetails),
      Promise.all(sendEmails),
      createPendingApprovals(approvalEmails, orgId, teamId, teamName, userId)
    ]);

    const results = detailedInvitations.map((invitee) => {
      const {email, action} = invitee;
      let result = action;
      if (action === ASK_APPROVAL) {
        result = PENDING_APPROVAL;
      } else if (action === SEND_EMAIL || action === SEND_NOTIFICATION) {
        result = SUCCESS;
      }
      return {email, result};
    });
    return {results};
  }
};
