(() => {
    window.modSC2DataManager.getModLoadController().addLifeTimeCircleHook(
        'bsaBeautySwitcher',
        {
            ModLoaderLoadEnd: async () => {
                const logger = window.modUtils.getLogger();
                const maplebirchMod =
                    window.modUtils.getAnyModByNameNoAlias('maplebirch');

                if (maplebirchMod) {
                    maplebirch.modList.pushUnique("美化切換");
                    maplebirch.tool.addTo('MenuSmall', 'bsaBeautySwitcherButton');

                    logger.log(
                        '[BSABeautySwitcher] Maplebirch 已註冊美化切換'
                    );
                } else {
                    logger.error(
                        '[BSABeautySwitcher] 未檢測到 Maplebirch'
                    );
                }
            },
        }
    );
})();