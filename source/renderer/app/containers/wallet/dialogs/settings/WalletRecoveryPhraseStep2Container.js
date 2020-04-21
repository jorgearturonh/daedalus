// @flow
import React, { Component } from 'react';
import { observer, inject } from 'mobx-react';
import WalletRecoveryPhraseStep2Dialog from '../../../../components/wallet/settings/WalletRecoveryPhraseStep2Dialog';
import WalletRecoveryPhraseStep3Dialog from '../../../../components/wallet/settings/WalletRecoveryPhraseStep3Dialog';
import WalletRecoveryPhraseStep4Dialog from '../../../../components/wallet/settings/WalletRecoveryPhraseStep4Dialog';
import validWords from '../../../../../../common/crypto/valid-words.en';
import { isValidMnemonic } from '../../../../../../common/crypto/decrypt';
import { WALLET_RECOVERY_PHRASE_STATUSES } from '../../../../config/walletRecoveryPhraseConfig';
import type { InjectedDialogContainerProps } from '../../../../types/injectedPropsType';

type Props = InjectedDialogContainerProps;

@inject('stores', 'actions')
@observer
export default class WalletRecoveryPhraseStep2Container extends Component<Props> {
  static defaultProps = {
    actions: null,
    stores: null,
    children: null,
    onClose: () => {},
  };

  componentWillMount() {
    this.props.actions.walletBackup.resetRecoveryPhraseCheck.trigger();
  }

  componentWillReceiveProps(nextProps: Props) {
    const { walletBackup } = nextProps.stores;
    const { actions } = this.props;
    const { recoveryPhraseStatus } = walletBackup;
    const { CORRECT, INCORRECT } = WALLET_RECOVERY_PHRASE_STATUSES;
    let dialog;
    if (recoveryPhraseStatus === CORRECT) {
      dialog = WalletRecoveryPhraseStep3Dialog;
      actions.wallets.updateRecoveryPhraseVerificationDate.trigger();
    } else if (recoveryPhraseStatus === INCORRECT) {
      dialog = WalletRecoveryPhraseStep4Dialog;
    }
    if (dialog) {
      actions.dialogs.open.trigger({
        dialog,
      });
      actions.walletBackup.resetRecoveryPhraseCheck.trigger();
    }
  }

  handleVerify = (recoveryPhrase: Array<string>) => {
    this.props.actions.walletBackup.checkRecoveryPhrase.trigger({
      recoveryPhrase,
    });
  };

  render() {
    const { stores, actions } = this.props;
    const { closeActiveDialog } = actions.dialogs;
    const { active: activeWallet } = stores.wallets;
    if (!activeWallet) throw new Error('Active wallet required.');
    const wordCount = activeWallet.discovery === 'random' ? 12 : 15;
    return (
      <WalletRecoveryPhraseStep2Dialog
        mnemonicValidator={isValidMnemonic}
        suggestedMnemonics={validWords}
        onVerify={this.handleVerify}
        onClose={closeActiveDialog.trigger}
        wordCount={wordCount}
      />
    );
  }
}
