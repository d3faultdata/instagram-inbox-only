chrome.runtime.onInstalled.addListener(() => {
  const rule = {
    id: 1,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        url: "https://www.instagram.com/direct/inbox/"
      }
    },
    condition: {
      resourceTypes: ["main_frame"],
      requestDomains: ["www.instagram.com", "instagram.com"]
    }
  };

  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [rule]
  });
});
