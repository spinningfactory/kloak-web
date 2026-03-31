import DefaultTheme from 'vitepress/theme'
import { onMounted } from 'vue'

export default {
  extends: DefaultTheme,
  setup() {
    onMounted(() => {
      const logoLink = document.querySelector('.VPNavBarTitle a')
      if (logoLink) {
        logoLink.setAttribute('href', '/')
      }
    })
  }
}
