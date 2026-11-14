/** Keep the actual captured Settings options, renderer, dialogs and handlers.
 * Adapt profile ownership and the rename draft at their original entry points. */
export function configureSettings(original) {
  const methods=original.methods;
  return {...original,
    computed:{...original.computed,
      profileLocked(){const state=window.__holodoriDesktop.settingsState;return !!(state?.busy||state?.restore||state?.profileImport||state?.gameImport||state?.deleteStage);},
      profileActionError(){return window.__holodoriDesktop.settingsState.profileActionError||'';}
    },
    watch:{...original.watch,
      renameModal(open){if(open){this.newName=this.settings.account_names[this.account]||'';this.renameAccount=this.account;}},
      deleteModal(open){if(open)window.__holodoriDesktop.settingsState.profileActionError='';},
      account(){this.errorMsg=null;this.successMsg=null;this.renameModal=false;this.deleteModal=false;}
    },
    methods:{...methods,
      saveName(){
        if(this.profileLocked||this.renameAccount!==this.account)return;
        this.newName=this.newName.trim();
        methods.saveName.call(this);
      },
      setAccount(event){
        if(!window.__holodoriDesktop.prepareProfileSwitch()){event.target.value=this.account;return;}
        methods.setAccount.call(this,event);
      },
      addAccount(){
        if(!window.__holodoriDesktop.prepareProfileSwitch())return;
        methods.addAccount.call(this);
      }
    }
  };
}
