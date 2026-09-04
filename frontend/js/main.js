(function ($) {
    "use strict";
    // Spinner
    var spinner = function () {
        setTimeout(function () {
            if ($('#spinner').length > 0) {
                $('#spinner').removeClass('show');
            }
        }, 1);
    };
    spinner(0);

    // Initiate the wowjs
    new WOW().init();

    // Fixed Navbar + back-to-top: jedan pasivni scroll listener i najviše
    // jedan zakazan animation frame, bez ponovljenih DOM upita po scroll eventu.
    var $stickyTop = $('.sticky-top');
    var $backToTop = $('.back-to-top');
    var scrollFrameScheduled = false;
    var controlsVisible = null;

    function updateScrollControls() {
        scrollFrameScheduled = false;
        var shouldShow = window.scrollY > 300;
        if (shouldShow === controlsVisible) return;
        controlsVisible = shouldShow;

        $stickyTop.toggleClass('shadow-sm', shouldShow).css('top', shouldShow ? '0px' : '-300px');
        $backToTop.stop(true, true)[shouldShow ? 'fadeIn' : 'fadeOut']('slow');
    }

    window.addEventListener('scroll', function () {
        if (scrollFrameScheduled) return;
        scrollFrameScheduled = true;
        window.requestAnimationFrame(updateScrollControls);
    }, { passive: true });
    updateScrollControls();

    // Smooth scrolling on the navbar links
    $(".navbar-nav a").on('click', function (event) {
        if (this.hash !== "") {
            event.preventDefault();
            $('html, body').animate({
                scrollTop: $(this.hash).offset().top - 90
            }, 1500, 'easeInOutExpo');
            if ($(this).parents('.navbar-nav').length) {
                $('.navbar-nav .active').removeClass('active');
                $(this).closest('a').addClass('active');
            }
        }
    });

    $('.back-to-top').click(function () {
        $('html, body').animate({scrollTop: 0}, 1500, 'easeInOutExpo');
        return false;
    });

})(jQuery);
