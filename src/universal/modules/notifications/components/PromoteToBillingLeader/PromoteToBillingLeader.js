import {css} from 'aphrodite-local-styles/no-important';
import PropTypes from 'prop-types';
import React from 'react';
import {createFragmentContainer} from 'react-relay';
import {withRouter} from 'react-router-dom';
import Button from 'universal/components/Button/Button';
import IconAvatar from 'universal/components/IconAvatar/IconAvatar';
import Row from 'universal/components/Row/Row';
import defaultStyles from 'universal/modules/notifications/helpers/styles';
import ClearNotificationMutation from 'universal/mutations/ClearNotificationMutation';
import ui from 'universal/styles/ui';
import withStyles from 'universal/styles/withStyles';
import {clearNotificationLabel} from '../../helpers/constants';

const PromoteToBillingLeader = (props) => {
  const {
    atmosphere,
    history,
    styles,
    notification,
    submitting,
    submitMutation,
    onError,
    onCompleted
  } = props;
  const {notificationId, organization: {orgName, orgId}} = notification;
  const acknowledge = () => {
    submitMutation();
    ClearNotificationMutation(atmosphere, notificationId, onError, onCompleted);
  };
  const goToOrg = () => {
    submitMutation();
    ClearNotificationMutation(atmosphere, notificationId, onError, onCompleted);
    history.push(`/me/organizations/${orgId}`);
  };

  return (
    <Row compact>
      <div className={css(styles.icon)}>
        <IconAvatar icon="building" size="small" />
      </div>
      <div className={css(styles.message)}>
        {'You are now a '}<b><i>{'Billing Leader'}</i></b>{' for '}
        <span className={css(styles.messageVar, styles.notifLink)} onClick={goToOrg}>{orgName}</span>{'.'}
      </div>
      <div className={css(styles.widerButton)}>
        <Button
          aria-label="Go to the Organization page"
          colorPalette="cool"
          isBlock
          label="See Organization"
          buttonSize={ui.notificationButtonSize}
          type="submit"
          onClick={goToOrg}
          waiting={submitting}
        />
      </div>
      <div className={css(styles.iconButton)}>
        <Button
          aria-label={clearNotificationLabel}
          buttonSize="small"
          colorPalette="gray"
          icon="check"
          isBlock
          onClick={acknowledge}
          type="submit"
          waiting={submitting}
        />
      </div>
    </Row>
  );
};

PromoteToBillingLeader.propTypes = {
  atmosphere: PropTypes.object.isRequired,
  history: PropTypes.object.isRequired,
  onCompleted: PropTypes.func.isRequired,
  onError: PropTypes.func.isRequired,
  styles: PropTypes.object,
  submitMutation: PropTypes.func.isRequired,
  submitting: PropTypes.bool,
  notification: PropTypes.object.isRequired
};

const styleThunk = () => ({
  ...defaultStyles,

  button: {
    marginLeft: ui.rowGutter,
    minWidth: '3.5rem'
  }
});

export default createFragmentContainer(
  withRouter(withStyles(styleThunk)(PromoteToBillingLeader)),
  graphql`
    fragment PromoteToBillingLeader_notification on NotifyPromoteToOrgLeader {
      notificationId: id
      organization {
        orgId: id
        orgName: name
      }
    }
  `
);
