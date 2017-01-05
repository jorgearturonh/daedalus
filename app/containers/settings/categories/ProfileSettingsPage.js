// @flow
import React, { Component, PropTypes } from 'react';
import { observer, inject, PropTypes as MobxPropTypes } from 'mobx-react';
import ProfileSettings from '../../../components/settings/categories/ProfileSettings';

@inject('state', 'controller') @observer
export default class ProfileSettingsPage extends Component {

  static propTypes = {
    state: PropTypes.shape({
      settings: PropTypes.shape({
        profile: MobxPropTypes.observableObject.isRequired
      }).isRequired,
      login: PropTypes.shape({
        isLoading: PropTypes.bool.isRequired
      }).isRequired
    }).isRequired,
    controller: PropTypes.shape({
      user: PropTypes.shape({
        updateField: PropTypes.func.isRequired
      }).isRequired
    }).isRequired
  };

  render() {
    const { profile } = this.props.state.settings;
    const { isLoading } = this.props.state.login;
    const { controller } = this.props;
    if (isLoading) return <div>Loading</div>;
    return (
      <ProfileSettings
        profile={profile}
        onFieldValueChange={(field, name) => controller.user.updateField(field, name)}
      />
    );
  }

}